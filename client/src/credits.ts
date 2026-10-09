/**
 * Third-party art used in the game. The single source for the in-game Credits window (mainMenu.ts) and checked against
 * CREDITS.md by client/test/credits.test.ts, so the two cannot drift apart. The weapon GLBs also carry their credit in
 * `asset.extras` (scripts/models/weapons.json -> scripts/prep-weapon.mjs).
 */

export interface CreditEntry {
  id: string;
  title: string;
  /** Creator, as named on the source page; null while unknown. */
  author: string | null;
  /** Licence name and, when there is one, where to read it. */
  license: string;
  licenseUrl?: string;
  /** Where the model came from (null while unknown). */
  url: string | null;
  /** What it is used for in the game. */
  use: string;
  /** What was changed from the original (CC BY asks for that to be said). */
  changes?: string;
  /** Open questions for the owner. */
  note?: string;
}

const CC_BY = { license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } as const;

export const CREDITS: CreditEntry[] = [
  {
    id: 'dual-sabers',
    title: 'Dual Sabers',
    author: 'Shadow Models 3D',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/dual-sabers-f35ef34053c74a228fb041aaf53bd15b',
    use: "The Warbringer's sabers (Warrior, arms spec).",
    changes: 'One saber kept and mirrored for the off hand; re-oriented and rescaled for the game; texture reduced.',
  },
  {
    id: 'greatsword',
    title: 'Greatsword',
    author: 'denisdezmand',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/greatsword-ddb0054280be46dba275758194c9ee4d',
    use: "The Rampager's greatsword (Warrior, fury spec).",
    changes: 'Re-oriented and rescaled for the game; textures reduced to one colour map per part; normal and ORM maps dropped.',
  },
  {
    id: 'tyra-polearm',
    title: 'Tyra Polearm',
    author: 'zenkuri (https://sketchfab.com/zenkuri)',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/tyra-polearm-b538efe0811148c28d697e3151d6bf2e',
    use: "The Barbarian's polearm (Warrior, protection spec).",
    changes: 'Re-oriented and rescaled for the game; textures reduced to one colour map per part; normal and metal/roughness maps dropped.',
  },
  // The mage: credited exactly as each file's own glTF metadata (asset.extras: title, author, licence, source) states it.
  {
    id: 'old-wizard',
    title: 'Terror Engine - Old Wizard',
    author: 'JuanCarlosOsanteHernandez',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/terror-engine-old-wizard-0561d94ddd46405aaea85043dbebbdaa',
    use: 'The body of every Mage spec (rigged and animated by its author; its idle, walk, run, attack and death clips are what the mage plays).',
    changes: 'Original staff removed (the spec staffs replace it); textures reduced to 1024 px or less and normal maps dropped; scaled and oriented for the game; robe tinted per spec and dyeable in the game.',
  },
  {
    id: 'fire-staff',
    title: 'Stylised Fire Staff',
    author: 'Bl4ckGh0st',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/stylised-fire-staff-fbd37dc983474820a2ad3c4e6872e6d5',
    use: "The Pyromancy mage's staff (Mage, fire spec).",
    changes: 'Wood decimated from 38.9k to 3.2k triangles and the flame cards reduced; textures reduced; flames drawn additively; rescaled for the game.',
  },
  {
    id: 'ice-staff',
    title: 'Stylized Magical Ice Staff - Game Ready',
    author: 'Nexus Assets',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/stylized-magical-ice-staff-game-ready-d98a534be7ef4b1e8de76182e355ce0b',
    use: "The Cryomancy mage's staff (Mage, frost spec).",
    changes: 'Decimated from 19.9k to 5.5k triangles; colour texture reduced; normal and metal/roughness maps dropped; rescaled for the game.',
  },
  {
    id: 'arcane-staff',
    title: 'Arcane staff of Resonance - WOW inspired weapon',
    author: 'Johan Pindeville',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/arcane-staff-of-resonance-wow-inspired-weapon-b2a8d6386cbd47939acadb94f637872a',
    use: "The Starweaving mage's staff (Mage, arcane spec).",
    changes: 'Decimated from 6.2k to 4.8k triangles; textures reduced; rescaled for the game.',
  },
  // The capes: credited exactly as the file's own glTF metadata (asset.extras: title, author, licence, source) states it.
  {
    id: 'cape',
    title: 'Cape',
    author: 'That one larry (https://sketchfab.com/Professor_E12)',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/cape-b9efc9d1f1234564b7d5afd20ef76ffc',
    use: 'The shape of every cape and cloak back cosmetic (each item is its own colours, trim and emblem on the same cloth).',
    changes: 'Body skeleton removed, the five cloth chains kept and moved by a small cloth simulation; texture reduced to a neutral 512 px shading map that the cosmetics colour; scaled and fitted per character model.',
  },
  // The wings: credited exactly as the file's own glTF metadata (asset.extras: title, author, licence, source) states it.
  {
    id: 'angel-wings',
    title: 'Angel wings',
    author: 'sxnneh (https://sketchfab.com/Sxnneh)',
    license: 'SKETCHFAB Standard (https://sketchfab.com/licenses)',
    url: 'https://sketchfab.com/3d-models/angel-wings-a575b36467d840be84d8f91d5074d7d4',
    use: 'The shape of every wing cosmetic (each item is its own colours, glow, layers and particles on the same feathered pair).',
    changes: 'Turned upright and centred on the shoulder joint, a seven-bone skeleton added so the wings can hinge, raise, bend and flutter, texture reduced to a neutral 512 px shading map that the cosmetics recolour; scaled and fitted per character model.',
    note: 'Sketchfab Standard licence, not Creative Commons: it needs a review before the Steam release (redistribution with the game must be allowed, or the model replaced).',
  },
  // The arenas: credited exactly as each file's own glTF metadata (asset.extras: title, author, licence, source) states it. The packs in
  // client/public/models/arenas carry the same three credits in asset.extras.credits (client/test/arenaPacks.test.ts checks both).
  {
    id: 'hell-arena',
    title: 'HELL ARENA',
    author: '3DMAN (https://sketchfab.com/3dmanx888)',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/hell-arena-9db7838c98ab4ae5a6a783dda03115eb',
    use: 'The crater rim, horns and lava look of the Cinder Crater arena.',
    changes: 'Fog mesh and the two lower-detail copies dropped, the 76k-triangle crater decimated to 18k with its texture kept; the four horns cut out as cover props; rescaled and lowered so the crater floor is the arena floor; the arena floor, walls and barricades are built from its lava and basalt look and from textures of the other hell arena.',
  },
  {
    id: 'hell-arena-lake',
    title: 'Hell arena',
    author: '3DMAN (https://sketchfab.com/3dmanx888)',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/hell-arena-14b8a6e3cba342f5a952ca5488180489',
    use: 'The rock ring, grate platform and the lava, basalt, brick and orange rock textures of the Lava Forge arena, and the lava and basalt textures of the Cinder Crater arena.',
    changes: 'Rock ring decimated and rescaled into a crater wall around the hall; textures reduced to 1024 px and made seamless; normal maps generated from the colour maps; the grate disc rescaled to cap the central plinth.',
  },
  {
    id: 'stadium-arena',
    title: 'Arena',
    author: 'lombardirowchik (https://sketchfab.com/lombardirowchik)',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/arena-0f990d29a01f4ef5b2c5013797ea32fc',
    use: 'The stadium shell and obelisks of the Sandstone Yard arena, and the sand, brick, cobble, carved block and sandstone textures that dress the other sand-coloured arenas.',
    changes: 'Rescaled from its very large units and turned upright; advertising boards, sky boxes, hanging lamps and the crate piles inside the yard removed; textures enlarged to 1024 px with fine grain, cropped to remove fringes and made seamless; normal maps generated from the colour maps.',
  },
  // The rogue: credited exactly as each file's own metadata (the USDZ's customLayerData, the GLB's asset.extras) states it.
  {
    id: 'hooded-assassin',
    title: 'Hooded Shadow Assassin',
    author: 'iRahulRajput',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/hooded-shadow-assassin-d3d3c1efefa34f95a0b0ebc0dbae620d',
    use: 'The body of every Rogue spec.',
    changes: 'Unrigged 781k-triangle mesh converted from USDZ, decimated to about 13k triangles, texture re-baked at 1024 px and brightened so dyes show, split into hood, shoulders, back and body parts, rigged with the game skeleton and skinned; scaled and oriented for the game.',
  },
  {
    id: 'twin-daggers',
    title: 'Pyke’s Dagger',
    author: 'RickLop',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/pykes-dagger-dfed510939ba407da280cdf03e1c85fa',
    use: 'The Twin Daggers every Rogue spec holds, one in each hand (the off hand is a mirrored copy).',
    changes: 'Decimated from 50k to 4.5k triangles; textures reduced to 512 px, normal and metal/roughness maps dropped; rescaled and re-oriented for the game.',
  },
  // The priest: credited exactly as each file's own metadata (the USDZ's customLayerData, the GLBs' asset.extras) states it.
  {
    id: 'abyssal-sentinel',
    title: 'Abyssal Sentinel Gizurr',
    author: 'Rignu',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/abyssal-sentinel-gizurr-03f0402715dd489fa3cb4894f81fde1f',
    use: 'The body of every Priest spec.',
    changes: 'Unrigged 1.1M-triangle mesh converted from USDZ; the floating halo frame, the sigil by the hand and the spars behind the head were cut away; decimated to about 13k triangles, texture re-baked at 1024 px, lightened and partly desaturated so dyes show; split into head, shoulders, back and body parts, rigged with the game skeleton and skinned; scaled and oriented for the game.',
  },
  {
    id: 'holy-staff',
    title: 'Holy Staff',
    author: '3DMode',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/holy-staff-e1c417929c424c15908014ef361bde15',
    use: 'The staff of the Warden and Lightbearer specs.',
    changes: 'Decimated from 46.5k to 9.5k triangles; the untextured materials recoloured in warm gold and white with a glowing crystal; rescaled and re-oriented for the game.',
  },
  {
    id: 'necro-staff',
    title: 'Necro Staff',
    author: 'suddel',
    ...CC_BY,
    url: 'https://sketchfab.com/3d-models/necro-staff-05bdb7eb36ea487a8acba0c71fa116ef',
    use: 'The staff of the Gloomweaver spec.',
    changes: 'Decimated from 500k to 7k triangles; base colour texture reduced to 512 px and brightened, normal and metal/roughness maps dropped; rescaled and re-oriented for the game.',
  },
  {
    id: 'gold-knight',
    title: 'Gold knight (Warrior character)',
    author: null,
    license: 'Supplied by the owner, source to be confirmed',
    url: null,
    use: 'The body of every Warrior spec (rigged and animated in the game).',
    changes: 'Decimated, re-textured and rigged with scripts/rig-model.mjs.',
    note: 'Author and licence to be confirmed.',
  },
  {
    id: 'brute',
    title: "Brute (Sketchfab FBX, mesh 'dede')",
    author: null,
    license: 'Supplied by the owner, source to be confirmed',
    url: null,
    use: 'The optional alternative Warrior model (?warriormodel=brute).',
    changes: 'Converted and rigged with scripts/convert-skinned.mjs.',
    note: 'Author and licence to be confirmed.',
  },
  {
    id: 'fire-flipbook',
    title: 'Fire flipbook (flame effects)',
    author: 'highwizard',
    license: 'Free for commercial use, no credit required (as the OpenGameArt listing states it)',
    url: 'https://opengameart.org/content/animated-flame-fire-sprite-sheet',
    use: "The flames of Dragon's Breath, Dragon Roar, Flamestrike, burning auras and other fire effects (client/public/fx/fire-sheet.webp).",
    changes: 'Re-saved as one WebP (25 frames, 128 px each); drawn additively. Without the file the game falls back to a flame it draws itself.',
    note: 'Matched to the OpenGameArt listing "Animated flame / Fire sprite Sheet" by highwizard (1x25, 5x5 and separate-frame versions, like the supplied zip). No licence file came inside the zip: confirm on the page that it is the same download and note the exact licence name.',
  },
  {
    id: 'fireball-sound',
    title: 'JM_FX_Fireball_01',
    author: 'Julien Matthey (julien_matthey on Freesound)',
    license: 'Licence to be confirmed by the owner (the Freesound licence must allow commercial use: CC BY-NC would not)',
    url: 'https://freesound.org/people/julien_matthey/sounds/105016/',
    use: 'The launch and the hit of Fireball, and (pitched down) of Pyroblast (client/public/audio/fireball-launch.mp3, fireball-hit.mp3).',
    changes: 'Two clips cut from the recording (the rising whoosh, then the burst and its decay), mixed to mono, loudness-matched, faded and encoded as MP3; Pyroblast plays them slower and lower.',
    note: 'Matched by the file name (Freesound sound 105016). The file carries no tags, so the licence is not known and the link could not be opened from here: read the licence on the Freesound page. CC0 and CC BY are fine (CC BY needs this credit); CC BY-NC is not allowed for a commercial release, in which case the sound has to be replaced (delete its entries in client/src/sampleTable.ts and the two files; the synthesised sounds play again).',
  },
  {
    id: 'icons-steadykeel',
    title: 'Spell and Skill Icons (steadykeel)',
    author: 'steadykeel (Graham Tizzard) on itch.io',
    license: 'Use in your own games is allowed; the files may not be resold, shared on their own or used to train AI',
    url: null,
    use: 'Two packs in the Icon edit library (framed and clear, 46 icons each). Not part of the repository: the game server hands them out, so the game never ships them in its files.',
    changes: 'Re-saved as 128 px WebP.',
    note: 'Served by the game server only. Check the itch.io page for the current terms before any change in how they are stored or shown.',
  },
  {
    id: 'icons-barbarian',
    title: 'Barbarian icon set',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Default icons of the Warrior skills (40 icons).',
    changes: 'Re-saved as 128 px WebP.',
    note: 'Author and licence to be confirmed.',
  },
  {
    id: 'icons-firemage',
    title: 'Fire mage icon set',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Default icons of the Fire mage skills (40 icons).',
    changes: 'Re-saved as 128 px WebP.',
    note: 'Author and licence to be confirmed.',
  },
  {
    id: 'icons-frostmage',
    title: 'Frost mage icon set',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Default icons of the Frost mage skills (25 icons).',
    changes: 'Re-saved as 128 px WebP.',
    note: 'Author and licence to be confirmed.',
  },
  {
    id: 'icons-151',
    title: 'Pixel icon set (151)',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Default icons of the Priest, Rogue, Arcane and trinket skills and of many buffs (151 icons).',
    changes: 'Re-saved as 128 px WebP; named "Icon 1" to "Icon 151".',
    note: 'No licence file came in the download. Author and licence to be confirmed.',
  },
  {
    id: 'icons-spellset',
    title: 'Spell set (2011)',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'A few default icons (Desperate Prayer, Vanish, Renew) and fill-ins in the Icon edit library (53 icons).',
    changes: 'Re-saved as 128 px WebP.',
    note: 'No licence file came in the download. Author and licence to be confirmed.',
  },
  {
    id: 'icons-batareya-mage',
    title: 'Mage icons (Batareya)',
    author: 'Batareya',
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Library only: 250 mage skill icons in the Icon edit library.',
    changes: 'Re-saved as 128 px WebP from 512 px originals; named "Mage 1" to "Mage 250".',
    note: 'The download (MAGE_ICONS_BIG_PACk_by_Batareya) carries no licence file. Licence to be confirmed.',
  },
  {
    id: 'icons-rpg-spells',
    title: 'RPG spell icons (elements)',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Library only: 40 fire, ice, earth and lightning icons in the Icon edit library.',
    changes: 'The single 32 px icons (not the sheets) enlarged to 128 px WebP without smoothing.',
    note: 'The download (RPG Spells Icons) carries no licence file. Author and licence to be confirmed.',
  },
  {
    id: 'icons-card-skills',
    title: 'Card game skill icons',
    author: null,
    license: 'Supplied by the owner, source and licence to be confirmed',
    url: null,
    use: 'Library only: 300 skill icons (arcane, blood, fire, frost, nature and more) in the Icon edit library.',
    changes: 'Only the skill icons (icon_content) of the magic card game pack v2, enlarged from 32 px to 128 px WebP without smoothing; named after the file, the school is a tag.',
    note: 'The download (magic card game pack v2) carries no licence file. Author and licence to be confirmed.',
  },
];
