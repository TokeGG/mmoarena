# Credits

The 3D models below are the work of their authors and are used under the licences shown. The same list is in the game: main menu, "Credits" (generated from `client/src/credits.ts`; a test keeps this file in step with it).

## Weapons (Warrior)

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Dual Sabers](https://sketchfab.com/3d-models/dual-sabers-f35ef34053c74a228fb041aaf53bd15b) | Shadow Models 3D | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Warbringer's sabers (arms spec) |
| [Greatsword](https://sketchfab.com/3d-models/greatsword-ddb0054280be46dba275758194c9ee4d) | denisdezmand | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Rampager's greatsword (fury spec) |
| [Divine Fantasy Axe](https://sketchfab.com/3d-models/divine-fantasy-axe-188fe88f2dab4513b76f2a47eeb1daba) | Xardkorich_3D | [Sketchfab Standard licence](https://sketchfab.com/licenses) | The Barbarian's two-handed axe (protection spec) |

Changes made to the originals: re-oriented and rescaled for the game, textures reduced (one colour map per part, normal and metal/roughness maps dropped), the sabers reduced to one blade that is mirrored for the off hand (`scripts/prep-weapon.mjs`; the game-ready files are in `client/public/models/weapons/` and carry their credit in the glTF `asset.extras`). The original downloads are not part of this repository.

The Divine Fantasy Axe is under Sketchfab's Standard licence, not a Creative Commons licence: the owner is to confirm that the model may be redistributed with the game.

## Mage (character and staffs)

Credited exactly as each file's own glTF metadata (`asset.extras`) names it.

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| [Terror Engine - Old Wizard](https://sketchfab.com/3d-models/terror-engine-old-wizard-0561d94ddd46405aaea85043dbebbdaa) | JuanCarlosOsanteHernandez | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The body of every Mage spec (rigged and animated by its author: idle, walk, run, attack and death clips) |
| [Stylised Fire Staff](https://sketchfab.com/3d-models/stylised-fire-staff-fbd37dc983474820a2ad3c4e6872e6d5) | Bl4ckGh0st | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Pyromancy staff (fire spec) |
| [Stylized Magical Ice Staff - Game Ready](https://sketchfab.com/3d-models/stylized-magical-ice-staff-game-ready-d98a534be7ef4b1e8de76182e355ce0b) | Nexus Assets | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Cryomancy staff (frost spec) |
| [Arcane staff of Resonance - WOW inspired weapon](https://sketchfab.com/3d-models/arcane-staff-of-resonance-wow-inspired-weapon-b2a8d6386cbd47939acadb94f637872a) | Johan Pindeville | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | The Starweaving staff (arcane spec) |

Changes made to the originals: the wizard's own staff was removed, textures reduced (1024 px or less, normal and metal/roughness maps dropped), the staffs decimated (fire 38.9k to 3.2k wood triangles plus reduced flame cards, ice 19.9k to 5.5k, arcane 6.2k to 4.8k), everything rescaled and re-oriented for the game (`scripts/prep-character.mjs`, `scripts/prep-weapon.mjs`; the game-ready files carry their credit in the glTF `asset.extras`). The original downloads are not part of this repository.

## Characters (Warrior)

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| Gold knight (Warrior character) | unknown | supplied by the owner, source to be confirmed | The body of every Warrior spec |
| Brute (Sketchfab FBX, mesh `dede`) | unknown | supplied by the owner, source to be confirmed | The optional alternative Warrior model (`?warriormodel=brute`) |

Both were decimated, re-textured and rigged for the game (`scripts/rig-model.mjs`, `scripts/convert-skinned.mjs`).
