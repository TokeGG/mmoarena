# Credits

The 3D models below are the work of their authors and are used under the licences shown. The same list is in the game: main menu, "Credits" (generated from `client/src/credits.ts`; a test keeps this file in step with it).

## Weapons (Warrior)

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Dual Sabers](https://sketchfab.com/3d-models/dual-sabers-f35ef34053c74a228fb041aaf53bd15b) | Shadow Models 3D | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Warbringer's sabers (arms spec) |
| [Greatsword](https://sketchfab.com/3d-models/greatsword-ddb0054280be46dba275758194c9ee4d) | denisdezmand | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Rampager's greatsword (fury spec) |
| [Tyra Polearm](https://sketchfab.com/3d-models/tyra-polearm-b538efe0811148c28d697e3151d6bf2e) | zenkuri (https://sketchfab.com/zenkuri) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Barbarian's polearm (protection spec) |

Changes made to the originals: re-oriented and rescaled for the game, textures reduced (one colour map per part, normal and metal/roughness maps dropped), the sabers reduced to one blade that is mirrored for the off hand (`scripts/prep-weapon.mjs`; the game-ready files are in `client/public/models/weapons/` and carry their credit in the glTF `asset.extras`). The original downloads are not part of this repository.


## Mage (character and staffs)

Credited exactly as each file's own glTF metadata (`asset.extras`) names it.

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Terror Engine - Old Wizard](https://sketchfab.com/3d-models/terror-engine-old-wizard-0561d94ddd46405aaea85043dbebbdaa) | JuanCarlosOsanteHernandez | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The body of every Mage spec (rigged and animated by its author: idle, walk, run, attack and death clips) |
| [Stylised Fire Staff](https://sketchfab.com/3d-models/stylised-fire-staff-fbd37dc983474820a2ad3c4e6872e6d5) | Bl4ckGh0st | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Pyromancy staff (fire spec) |
| [Stylized Magical Ice Staff - Game Ready](https://sketchfab.com/3d-models/stylized-magical-ice-staff-game-ready-d98a534be7ef4b1e8de76182e355ce0b) | Nexus Assets | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Cryomancy staff (frost spec) |
| [Arcane staff of Resonance - WOW inspired weapon](https://sketchfab.com/3d-models/arcane-staff-of-resonance-wow-inspired-weapon-b2a8d6386cbd47939acadb94f637872a) | Johan Pindeville | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Starweaving staff (arcane spec) |

Changes made to the originals: the wizard's own staff was removed, textures reduced (1024 px or less, normal and metal/roughness maps dropped), the staffs decimated (fire 38.9k to 3.2k wood triangles plus reduced flame cards, ice 19.9k to 5.5k, arcane 6.2k to 4.8k), everything rescaled and re-oriented for the game (`scripts/prep-character.mjs`, `scripts/prep-weapon.mjs`; the game-ready files carry their credit in the glTF `asset.extras`). The original downloads are not part of this repository.

## Capes

Credited exactly as the file's own glTF metadata (`asset.extras`) names it.

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Cape](https://sketchfab.com/3d-models/cape-b9efc9d1f1234564b7d5afd20ef76ffc) | That one larry (https://sketchfab.com/Professor_E12) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The shape of every cape and cloak back cosmetic (each item is its own colours, trim and emblem on the same cloth) |

Changes made to the original: body skeleton removed, the five cloth chains kept and moved by a small cloth simulation, texture reduced to a neutral 512 px shading map that the cosmetics colour, scaled and fitted per character (`scripts/prep-cape.mjs`; the game-ready file carries its credit in the glTF `asset.extras`). The original download is not part of this repository.

## Wings

Credited exactly as the file's own glTF metadata (`asset.extras`) names it.

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Angel wings](https://sketchfab.com/3d-models/angel-wings-a575b36467d840be84d8f91d5074d7d4) | sxnneh (https://sketchfab.com/Sxnneh) | SKETCHFAB Standard (https://sketchfab.com/licenses) | The shape of every wing cosmetic (each item is its own colours, glow, layers and particles on the same feathered pair) |

Changes made to the original: turned upright and centred on the shoulder joint, a seven-bone skeleton added so the wings can hinge, raise, bend and flutter, texture reduced to a neutral 512 px shading map that the cosmetics recolour, scaled and fitted per character (`scripts/prep-wings.mjs`; the game-ready file carries its credit in the glTF `asset.extras`). The original download is not part of this repository.

**Licence review needed:** this is the Sketchfab Standard licence, not a Creative Commons one. It has to be reviewed before the Steam release (does it allow redistributing the model inside a commercial game?); until then the wings ship only as a packed `.pak` (`client/public/models/wings.pak`) like the other models, and the plain GLB stays out of git. If the licence does not allow it, replace the model (see DEVELOPING.md, "Adding a wing style") and remove this entry.

## Rogue (character and daggers)

Credited exactly as each file's own metadata names it (the USDZ's `customLayerData`, the GLB's `asset.extras`).

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Hooded Shadow Assassin](https://sketchfab.com/3d-models/hooded-shadow-assassin-d3d3c1efefa34f95a0b0ebc0dbae620d) | iRahulRajput | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The body of every Rogue spec |
| [Pyke’s Dagger](https://sketchfab.com/3d-models/pykes-dagger-dfed510939ba407da280cdf03e1c85fa) | RickLop | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Twin Daggers, one in each hand of every Rogue spec |

Changes made to the originals: the assassin (an unrigged 781k-triangle mesh, converted from USDZ) was decimated to about 13k triangles, its texture re-baked at 1024 px and brightened so dyes show, split into hood, shoulders, back and body parts, then rigged and skinned with the game's skeleton (`scripts/rig-model.mjs`); the dagger was decimated from 50k to 4.5k triangles with textures reduced to 512 px (`scripts/prep-weapon.mjs`). The original downloads are not part of this repository.

## Priest (character and staffs)

Credited exactly as each file's own metadata names it (the USDZ's `customLayerData`, the GLBs' `asset.extras`).

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Abyssal Sentinel Gizurr](https://sketchfab.com/3d-models/abyssal-sentinel-gizurr-03f0402715dd489fa3cb4894f81fde1f) | Rignu | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The body of every Priest spec |
| [Holy Staff](https://sketchfab.com/3d-models/holy-staff-e1c417929c424c15908014ef361bde15) | 3DMode | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The staff of the Warden and Lightbearer specs |
| [Necro Staff](https://sketchfab.com/3d-models/necro-staff-05bdb7eb36ea487a8acba0c71fa116ef) | suddel | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The staff of the Gloomweaver spec |

Changes made to the originals: the sentinel (an unrigged 1.1M-triangle mesh, converted from USDZ) lost its floating halo frame, the sigil beside its hand and the spars behind the head, was decimated to about 13k triangles, its texture re-baked at 1024 px, lightened and partly desaturated so dyes show, split into head, shoulders, back and body parts, then rigged and skinned with the game's skeleton (`scripts/rig-model.mjs`); the holy staff was decimated from 46.5k to 9.5k triangles and recoloured in gold and white; the necro staff was decimated from 500k to 7k triangles with its texture reduced to 512 px (`scripts/prep-weapon.mjs`). The original downloads are not part of this repository.

## Characters (Warrior)

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| Gold knight (Warrior character) | unknown | supplied by the owner, source to be confirmed | The body of every Warrior spec |
| Brute (Sketchfab FBX, mesh `dede`) | unknown | supplied by the owner, source to be confirmed | The optional alternative Warrior model (`?warriormodel=brute`) |

Both were decimated, re-textured and rigged for the game (`scripts/rig-model.mjs`, `scripts/convert-skinned.mjs`).

## Effects

| Asset | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Fire flipbook (flame effects)](https://opengameart.org/content/animated-flame-fire-sprite-sheet) | highwizard | Free for commercial use, no credit required (as the OpenGameArt listing states it) | The flames of Dragon's Breath, Dragon Roar, Flamestrike, burning auras and other fire effects |

Re-saved as one WebP (25 frames, 128 px each) and drawn additively; without it the game falls back to a flame it draws itself.

## Arenas

Credited exactly as each file's own glTF metadata (`asset.extras`) names it.

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [HELL ARENA](https://sketchfab.com/3d-models/hell-arena-9db7838c98ab4ae5a6a783dda03115eb) | 3DMAN (https://sketchfab.com/3dmanx888) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The crater rim, horns and lava look of the Cinder Crater arena |
| [Hell arena](https://sketchfab.com/3d-models/hell-arena-14b8a6e3cba342f5a952ca5488180489) | 3DMAN (https://sketchfab.com/3dmanx888) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The rock ring, grate platform and the lava, basalt, brick and orange rock textures of the Lava Forge (and lava and basalt textures of the Cinder Crater) |
| [Arena](https://sketchfab.com/3d-models/arena-0f990d29a01f4ef5b2c5013797ea32fc) | lombardirowchik (https://sketchfab.com/lombardirowchik) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The stadium shell and obelisks of the Sandstone Yard, and the sand, brick, cobble, carved block and sandstone textures that dress the other sand-coloured arenas |

Changes made to the originals: rescaled and re-oriented for the game, the crater decimated (76k to 18k triangles), advertising boards, sky boxes, fog meshes and hanging lamps removed, textures reduced or enlarged to 1024 px, cropped and made seamless with normal maps generated from the colour maps (`scripts/prep-arena.mjs`; the game-ready packs in `client/public/models/arenas/` carry their credits in the glTF `asset.extras`). The ice, snow, moss brick, flagstone and plank textures of the other arenas are generated by the same script and are not taken from any model. The original downloads are not part of this repository.

## Icon packs

The art of skills and buffs (shared/data/icons.json says which icon each one wears; the Icon edit page in the dev tools picks from every pack).

| Pack | Author | Licence | Used for |
| --- | --- | --- | --- |
| Spell and Skill Icons | steadykeel (Graham Tizzard) on itch.io | Use in your own games is allowed; the files may not be resold, shared on their own or used to train AI | Two packs (framed and clear, 46 icons each) in the Icon edit library |
| Barbarian icon set | Unknown | Supplied by the owner, source and licence to be confirmed | Default icons of the Warrior skills (40 icons) |
| Fire mage icon set | Unknown | Supplied by the owner, source and licence to be confirmed | Default icons of the Fire mage skills (40 icons) |
| Frost mage icon set | Unknown | Supplied by the owner, source and licence to be confirmed | Default icons of the Frost mage skills (25 icons) |
| Pixel icon set (151) | Unknown | Supplied by the owner, source and licence to be confirmed | Default icons of the Priest, Rogue, Arcane and trinket skills and of many buffs (151 icons) |
| Spell set (2011) | Unknown | Supplied by the owner, source and licence to be confirmed | A few default icons and fill-ins in the Icon edit library (53 icons) |

The steadykeel packs are served by the game server only: they are not in this repository, and the game's own files do not ship them. All icons are re-saved as 128 px WebP.

## Sounds

Almost all sound is synthesised in code; recorded samples are listed here (`client/src/sampleTable.ts`).

| Sound | Author | Licence | Used for |
| --- | --- | --- | --- |
| [JM_FX_Fireball_01](https://freesound.org/people/julien_matthey/sounds/105016/) | Julien Matthey (julien_matthey on Freesound) | Licence to be confirmed by the owner (the Freesound licence must allow commercial use: CC BY-NC would not) | The launch and the hit of Fireball, and (pitched down) of Pyroblast |

Two clips cut from the recording (the rising whoosh, then the burst and its decay), mixed to mono, loudness-matched, faded and encoded as MP3. The file carries no tags, so the licence is not known and the Freesound page could not be opened from here: it has to be read there before release. The original WAV is not part of this repository.
