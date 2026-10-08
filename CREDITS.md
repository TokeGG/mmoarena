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

## Characters (Warrior)

| Model | Author | Licence | Used for |
| --- | --- | --- | --- |
| Gold knight (Warrior character) | unknown | supplied by the owner, source to be confirmed | The body of every Warrior spec |
| Brute (Sketchfab FBX, mesh `dede`) | unknown | supplied by the owner, source to be confirmed | The optional alternative Warrior model (`?warriormodel=brute`) |

Both were decimated, re-textured and rigged for the game (`scripts/rig-model.mjs`, `scripts/convert-skinned.mjs`).
