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
    id: 'divine-fantasy-axe',
    title: 'Divine Fantasy Axe',
    author: 'Xardkorich_3D',
    license: 'Sketchfab Standard licence',
    licenseUrl: 'https://sketchfab.com/licenses',
    url: 'https://sketchfab.com/3d-models/divine-fantasy-axe-188fe88f2dab4513b76f2a47eeb1daba',
    use: "The Barbarian's two-handed axe (Warrior, protection spec).",
    changes: 'Re-oriented and rescaled for the game; colour texture reduced; normal and metal/roughness maps dropped.',
    note: 'Standard licence, not Creative Commons: the owner confirms the model may be redistributed with the game.',
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
];
