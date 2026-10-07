# WoW-style Arena · v0.55.3

A 3D third-person arena game in the style of WoW arena that runs in your browser. Tab-target combat, 1v1, 2v2 or 3v3, four classes with specs and talents, bots to practice against (opponents are always random classes, rolled each time you press Practice), ranked matches, friends and parties, replays and live spectating. Nothing to download or install.

## Play now

**https://mmoarena.onrender.com**

Open the link in Chrome, Edge or Firefox on a computer (mouse and keyboard), pick a class, a spec and talents, then press **Practice** (bots) or **Ranked** (needs an account).

- The first visit after a quiet spell can take up to a minute while the server wakes up. If the page is slow, wait and reload.
- Guests can play practice and everything else except ranked, rating, history, friends and the leaderboard. Sign up (name + password) in the menu to keep your rating, unlocks, settings and history.
- If the game looks outdated after an update, press **Ctrl+Shift+R** to reload fresh.
- Play with friends: add them in the friends panel, make a party, or challenge them to a duel.

## Play modes

- **Practice**: a private match against bots or training dummies. Choose 1v1, 2v2 or 3v3, who the enemies are, who your partners are (a bot of any class, or none), the bot level and the map. Nothing moves your rating.
- **Ranked** (needs an account): joins the queue for the size you picked (1v1, 2v2, 3v3). The server pairs waiting players in the order they queued; players who chose a specific arena only play there and Random players fit anywhere. Your rating changes with the result. Leaving a live ranked match is a loss.
- **Parties** (up to 3 friends): the lobby lists who is in your party and who is ready. The leader picks the mode and arena (Practice or Ranked); everyone else presses Ready instead. A party plays on one team, in practice too (friends replace ally bots). A party larger than the team size (for example 2 friends in a 1v1) queues as separate players, so they can be matched against each other.
- **Duels**: challenge an online friend to an unranked 1v1. Both of you use the class and build selected in the menu.
- **Watch live**: the menu lists every match in progress (ranked, queue games, duels and bot practice; solo dummy training is private). Spectators see everything five seconds late, so watching cannot help the players.
- **Replays**: Profile > Matches keeps your last 30 counted matches, each with a replay button.
- **Maps** (three arenas, each with its own layout and look; pick one or leave it on Random):

| Map | Feel |
|---|---|
| Dusk Colosseum | Sand arena with a pillar ring, warm light |
| Sunken Ruins | Broken walls and cover, lots of line-of-sight play |
| Frostkeep Pit | Cold stone pit with ice and open sight lines |

- A match counts only if it was live 20 s or more, was not dummy practice, and you did not forfeit.

## Controls (rebindable)

Defaults: RMB-drag steer · LMB-drag orbit camera · both mouse buttons run forward · W/S move · Q/E strafe · A/D turn (strafe while RMB held) · Space jump · wheel zoom (scroll all the way in for first person; the camera also drops into first person when a wall or pillar is right behind you) · Tab next enemy · click to target (click yourself or your own frame to target yourself) · 1-8 abilities (drag one action slot onto another to rearrange; saved per spec) · R toggles auto-attack (it also starts when you use a melee ability, and stops after 5 s out of combat or when you click off your target onto empty space, or press Esc to clear it); right-click an enemy (a click, not a drag) targets it and starts auto-attack, left-click only targets.

**Esc** clears your target first, then opens the menu: Resume, Controls, an Auto-attack on/off toggle, mouse sensitivity, volume sliders, HUD editor, Leave match. In **Controls** click a box and press a key, or hold **Shift / Ctrl / Alt** and press one for a combo such as Shift+1 (a plain binding still fires with a modifier held unless that exact combo is bound; release a modifier on its own to bind the modifier itself; browsers may grab some Ctrl combos); every action has two slots, right-click clears a slot, binding a key that is in use moves it, and Esc itself is reserved. The same screen is on the join page. Signed in, your keybinds, HUD, volume and builds follow your account to any device.

## Classes, specs and talents

Four classes: Warrior (rage), Mage (mana), Priest (mana), Rogue (energy). Each has **3 specs** with their own **eight-ability bar** (keys 1-8) and passive modifiers (for example Frost, Fire and Arcane), and **6 talent tiers**, one pick per tier:

**Talents belong to your spec (0.41):** each of the 12 specs has its own six tiers, three options each, tailored to what that spec does.

- **Tier I (shared, 0.41.1):** the same three talents for all three specs of a class; they only modify the skills every spec of that class has (for example Mage: Polymorph, Counterspell, Blink). Your tier I pick carries over when you change spec.
- **Tiers II and III:** buffs for that spec's own abilities (damage, healing, cooldowns, longer slows and stuns, survivability). Tier III is the utility tier; for mages it is the **Blink tier** (two blinks per cooldown, a run-speed burst after blinking, or faster casts after blinking).
- **Tiers IV, V and VI (skill replacements):** each choice adds an ability that takes the place of one bar slot (tier IV, V and VI each replace a different slot, so you can take all three; the tooltip says what you give up). Every spec has nine abilities it can bring in this way. Switching spec clears your talent picks.
- **Ground-spell aiming (0.55.3):** Flamestrike and other ground spells can be placed anywhere around you, not just in front. The aim marker has a center dot, and both turn red when the spot has no line of sight. The spell fires on mouse-down, so the camera no longer turns while you hold the click.
- **CC and shield tweaks (0.55.2):** Devouring Plague's opening hit no longer breaks fear. Ice Barrier absorbs 40% of your max health (was a flat 450). Dragon's Breath is now a disorient (4 s, shares diminishing returns with fear, does not break on damage) that Blink cannot remove.
- **Frost Nova and Fingers of Frost (0.55.1):** Frost Nova now also leaves a stack of Fingers of Frost on every enemy it hits, so Ice Lance follows it at full strength. Ice Lance's cooldown is 1 s (was 3 s). Mind Blast hits for about 340 (was 230).
- **Talent rows, frost, priest and warrior changes (0.55.0):** talent rows 1 to 3 now follow one pattern for every class: row 1 modifies skills all specs share, row 2 is a stat modifier identical for every spec, row 3 modifies the spec's own abilities (the old row 2 and 3 picks were reshuffled, so saved warrior, mage and priest picks in those rows reset). Cryomancy: Deep Freeze stuns for 4 s and applies Shatter for 4 s; Frost Nova roots and applies Shatter for 6 s; Fingers of Frost stacks to 2, each Ice Lance uses one, and Ice Lance glows on the bar while your target has it. Priest: Shadow Word: Death is now named Shadow Word: Pain and the old Shadow Word: Pain is Devouring Plague, which also hits for 300 on application; Mind Flay slows by 30%. Warbringer: Cleave has a 2.5 s cooldown, costs no rage and gives 15; Mortal Strike hits for about 400 (up to x1.5 with more rage), has a 6 s cooldown and applies Mortal Wounds (-40% healing received, 8 s); Slice and Dice has a 30 s cooldown and 100 damage per tick. Duels are always on one random map. Suggestions can carry an attached .txt note (up to 10,000 characters) that the owner can read and that is sent to Discord as a file.
- **Suggestion delete and tidier menu corner (0.54.2):** the owner can delete a suggestion from the box (Delete next to each one). The top-right buttons (account, Friends, Suggest) are now one tidy row with the party on its own line underneath, instead of a ragged column.
- **Suggestions to Discord, Kick and Pummel (0.54.1):** every suggestion is also posted to a Discord channel when the server has the `SUGGESTION_WEBHOOK_URL` environment variable set to a Discord webhook (it is a secret: set it in Render, never in the repo; mentions are stripped). Kick and Pummel can now be used on a target that is not casting: they miss and go on cooldown, like Counterspell.
- **Suggestion box and Counterspell (0.54.0):** a 💡 Suggest button in the main menu opens a box where anyone can send an idea (600 characters, one every 20 s); the owner sees everything that has come in under it. Counterspell can now be cast when the target is not casting (or just too late): it shows Missed and goes on its 24 s cooldown. It still ignores school lockouts and facing. Pummel is unchanged and still needs a casting target.
- **Barbarian tuning (0.53.1):** Reel In is now a 10 yard, 90 degree cone in front of you that pulls every enemy in it (no target needed). Deep Cuts costs no rage, generates 10 and has a 4 s cooldown. Axe Throw costs 50 rage, has a 2 s cooldown and hits for 300. Arcane Barrage now adds 75% damage per Arcane Charge (was 50%).
- **Rematch ready check and learning from people (0.53.0):** the end screen has Ready: play again and Leave. The room no longer closes after 20 s: it waits until every player is ready (then the same players, sides and bots start a fresh match) or people leave, and a leaver never blocks the rest. After each recorded match the server plays the replay back, measures what every human did (how much they strafe, how far they stand from the target, health when they use a defensive, whether they go for the healer, whether they focus their team's target) and keeps a running per-class human style. Each class's bot population gets a "human" variant (the best bot brain pulled up to 70% towards that style) that competes like any other, so it only sticks if it beats people. Also: Slice and Dice's first stun and cut land the moment it starts; Flamestrike always grants Hot Streak when its opening hit lands on an enemy (Fireball and Dragon's Breath stay at 15%), Scorch is 25%; every Arcane Missile has a 30% chance to add an Arcane Charge; Arcane Power lasts 15 s and also cuts cast times by 30%.
- **Hot Streak procs (0.52.1):** Fireball, Flamestrike and Dragon's Breath now each have a 15% chance per cast (like Scorch) to grant Hot Streak, making your next Pyroblast instant. An area spell rolls once per cast, not once per enemy hit. Spec descriptions are shortened to about two lines.
- **Cryomancy, leap and party fixes (0.52.0):** Frostbolt has a 15% chance to leave Fingers of Frost (15 s) on the target; Ice Lance on a target with it hits as if Shattered and uses it up. Shatter is now a mark on the target (5x frost damage) from Frost Nova and Deep Freeze; any damage removes it unless Deep Freeze's stun is active. Deep Freeze needs Fingers of Frost or Shatter on the target. Frost Nova's root breaks on damage. Heroic Leap is now a real leap: you fly through the air (about 0.5 to 0.9 s, no steering) and slam down for 120 damage to enemies within 5 yards. Leaving a match no longer closes your connection, so you stay in your party and it no longer breaks for your friends.
- **Warrior rework (0.51.0):** every warrior spec shares Charge, Pummel, Hamstring (now slow only, no damage) and Heroic Leap (jump to a spot, 60 s). Warbringer (dual wield): Cleave (was Whirlwind), Mortal Strike (spends all rage, up to x2.5 damage), Execute, Slice and Dice (4 s channelled cone that stuns and cuts). Rampager (two-hander, longer reach: 4.5 yd auto, +1.5 yd on Bloodthirst and Slam): Bladestorm, Bloodthirst (heals 3% max health, builds rage), Enraged Regeneration (-30% damage taken, Bloodthirst heals 23% for 8 s), Slam. Barbarian (polearm, replaces Bulwark): Reel In, Deep Cuts (3-stack bleed), Axe Throw (10 yd, rage), You're Not Going Anywhere (flag within 15 yd, enemies inside 5 yd cannot leave). Shield Slam is gone and all warrior talents are new, so saved warrior talent picks reset. Damage numbers are estimates, tuned with hard-bot duels: Barbarian's control still beats casters outright.
- **Warrior weapon specs (0.49.0):** warrior specs are now weapons, each with its own auto-attack and model. Warbringer (dual wield, spec id arms): Twin Blades, a fast 1.4 s swing for 62, Mortal Strike and no Bloodthirst. Rampager (two-handed sword, spec id fury): Greatsword, a slow 3 s swing for 165, Bloodthirst and no Mortal Strike. Bulwark (polearm, spec id protection): Halberd, a 2.4 s swing for 95 from 5 yards, plus 2 yards of reach on Halberd Slam (was Shield Slam), Concussion Blow, Hamstring and Pummel; Shield Wall is now Fortress Stance. Spec ids are unchanged so saved builds stay valid. Bots still use the default bar and sword. Spec balance has not been re-measured.
- **Lobby party tags (0.50.3):** the lobby now puts a name tag over every party member's model, with a green check when they are ready (the leader's crown shows, and the leader counts as ready); a member whose client has not reported a pick yet still appears, as their class's first spec, instead of being missing, and a pick with an invalid spec or an owner-only skin no longer hides the model (the bad part is dropped).
- **Party models in the lobby (0.50.2):** while you are in a party, the menu backdrop shows your party mates standing beside you with the class, spec weapon and skins they have picked, and the camera pulls back to fit them. Each member's client sends their pick to the party (`party_look`, validated like a join) whenever they change class, spec or gear, and the party panel data now carries it.
- **Shadowstep turns you round, presence and settings fixes (0.50.1):** Shadowstep now lands you on the far side of the target (its back), facing it, and Shadow Flicker does the same; the server sends a turn event and your camera swings round with you. Signed in, the client now reconnects by itself after you leave a match, so friends no longer show as offline (and duel/party invites no longer fail) until a refresh. Settings sync no longer rolls back edits the server never received: talents picked just before a refresh are kept and uploaded instead of being replaced by the account's older copy. Saved rogue talents from before 0.50.0 reset once because tiers I-III were replaced.
- **Rogue rework, learning bots, louder invites (0.50.0):** Shadowstep now gives 3 combo points. Shade's Sinister Strike is Backstab, which hits twice as hard from the target's rear arc (110 degrees either side of straight behind). Vanish also clears every slow and root. Rogue talents: tier I (all specs) is a Vanish upgrade, Smoke Veil (a 6 s smoke cloud), Twin Vanish (two charges, each on its own timer) or Shadow Mend (heals 75% of missing health, and does not break stealth); tier II (all specs) is 20% energy regen, 10% move speed, or Deep Pockets (8 combo point slots and 15% harder payoff scaling per point); tier III is per spec: Cutthroat Mutilate costs 10% less, re-Mutilating adds 3 s to the bleed, or slows 10%; Duelist Sinister Strike costs 10% less, has a 50% chance of 2 points, or slows 10%; Shade Backstab costs 10% less, has a 10% chance to first Shadowstep you behind the target for free (no points), or slows 10%. Tiers IV-VI (ability swaps) are unchanged. Bots now play from a tunable brain (cover and defensive thresholds, strafing, healer priority, focus fire, kiting range, heal timing, burst timing, chase) and Shade bots walk round to the target's back. Learning: `npx tsx scripts/train-bots.ts` runs bot-vs-bot self-play and writes the trained baseline to shared/data/botbrain.json; live, the server keeps six brain variants per class, hands one to every bot it spawns, credits each finished match against a human (20 s or longer, no draws) to that variant, and replaces the weakest with a mutation of the best, stored in the same Upstash store as accounts (memory only without it; `/api/status` shows the variants). Party invites are now big pulsing banners at the top of the screen with a countdown and the tab title flashes, the Friends button pulses, and a party chip with the member list stays on the menu.
- **Bots follow the patches (0.49.1):** bots now pick a spec (so they field every warrior weapon, mage, priest and rogue bar) and play whatever is on it: warrior bots use Execute, Concussion Blow, Recklessness and Enraged Regeneration with their spec's main strike, rogues use Mutilate/Sinister Strike, Garrote, Exsanguinate, Shadowstep and Adrenaline Rush, mages use every spec's nukes, Ice Barrier and Arcane Power, priests use Greater Heal, Pain Suppression, Penance, Mind Blast, Shadow Word: Death, Dispersion and Holy Nova. 24-seed hard duels with spec'd bots: warrior 23-1 mage, 16-8 rogue, 23-0 priest; rogue 16-8 mage; mage 9-14 priest. Also: Mortal Strike and Bloodthirst were swapped between Warbringer and Rampager (Warbringer has Mortal Strike, Rampager has Bloodthirst), and the end scoreboard now closes when the next round starts.
- **End scoreboard and warrior buff (0.48.0):** when a match ends, everyone in it gets the scoreboard (damage, healing, damage taken, healing received, overheal, by team) titled Victory, Defeat or Draw; B or the button hides it, spectators on the 5 s delay get it when they reach the end, and the room now stays open 20 s (was 8). Warrior damage is up about 30%: Mortal Strike 220, Bloodthirst 195, Execute 650, Whirlwind 115, Shield Slam 145, and auto-attacks hit for 80 (were 60). In 24-seed hard-bot duels the warrior went from 2-22 to 17-7 against the mage and now beats the priest outright; it still loses to the rogue (2-22 from 0-24), whose burst is the strongest in the game.
- **Camera under crowd control, shields (0.47.1):** while you are stunned, feared or polymorphed the camera anchor is damped heavily (the orbit, pitch and zoom stay fully yours) and your model shows the server's facing instead of snapping to the mouse, so the view no longer jerks as the server moves you. Shield and barrier absorb now actually draw: a white segment after your health, pushed back over the green at the end of the bar when health is full (a stylesheet rule had been hiding it).
- **Queue rules, blocked skills, owner scoreboard (0.47.0):** a spell you press while casting or on the global cooldown queues, but the spell you are casting right now is only queued again in the last 0.25 s of it, so one press never casts twice (a different spell always queues, newest wins). Skills with a condition (Execute below 20% health, interrupts on a casting target, stealth openers, finishers with no combo points) stay dark and do not highlight until the condition holds. The owner (after unlocking owner tools) watches matches with no delay and gets a scoreboard (button or **B**) with each player's damage, healing, damage taken, healing received and overheal, grouped by team; everyone else still watches five seconds behind with no stats.
- **Party matches (0.46.0):** with two or three friends in a party, the leader gets a **Party match** button: a friendly (unranked) match for the whole party. Each party chip has a Team 1 / Team 2 button (click your own to switch; sides start balanced), everyone must be Ready, and bots fill the empty places on each side at the chosen Bot skill. If more friends pick one side than the chosen team size, the match grows to fit (three friends on one side is a 3v3), so nobody is left out. Ranked and Find match still queue a party that is bigger than the team size as separate players.
- **Lag compensation and watching (0.45.0):** every cast now carries the server time of the frame you were looking at; the server keeps the last 12 ticks of positions and judges range, minimum range and facing against where the enemy stood on your screen (rewind capped at 300 ms, roughly your ping plus the 100 ms render delay; allies and your own position are never rewound, and line of sight, cooldowns and damage use live state). The rewind is written into the replay, so replays reproduce it exactly, and the 150 ms retry from 0.44.0 still covers what is left. Every match with a player in it can be watched (not just ranked): the list shows ranked ones with a trophy; solo dummy training stays private.
- **Server feel (0.44.0):** a player cast that fails only on range or facing is now held for 150 ms (`castGraceMs`) and retried every tick, so a target that was in reach on your screen but stepped away in transit still gets hit; a different press replaces the held cast, and bots and training dummies are never held. Measured server cost is tiny (a 3v3 tick is about 0.03 ms of sim plus 0.3 ms of snapshots, around 58 KB/s per client). Stealth no longer slows movement; feared units now stumble at 35% of run speed (was 50%). Heal floating text shows what landed plus a dim "N overheal" line, so a Flash Heal that rolls 323-378 on a target missing 250 shows +250.
- **Combo points (0.43.5):** combo points no longer drain out of combat. Kidney Shot is now a combo payoff (25 energy, 30 s cooldown): it stuns for 3 s plus 1 s per point spent, so 4 s on 1 point up to 8 s on 5 (diminishing returns still apply). Bots use it at 3+ points. **Dispersion (0.43.5)** can be used while stunned, feared or silenced (not while polymorphed) and removes every root and slow when cast; while it lasts you cannot use any ability (all slots black out).
- **Heal numbers (0.43.4):** base Flash Heal 350 (70 mana, 1.5 s) and Greater Heal 580 (90 mana, 2.6 s). Actual heals roll within ±8% (the global damage/heal variance) and scale with gear and talents; tooltips show the base number with your modifiers.
- **Control feedback and Flash Heal (0.43.3):** being stunned, feared, polymorphed or locked out by an interrupt now pulses a coloured glow around the screen edge (red stun, purple fear, blue sheep, gold school lockout), shows a larger banner with the time left, and blacked-out action slots count down their own time. Flash Heal heals 320 (was 160) for the same 70 mana (0.43.4: now 350).
- **Mind Flay beam, Dispersion (0.43.2):** Mind Flay is drawn and described as a continuous beam (same six pulses of damage, still broken by moving or interrupts); Dispersion now cuts damage taken by 90% (was 60%) for its 6 s.
- **Spell queue (0.43.1):** pressing a global-cooldown spell while you are casting or on the GCD holds it (the newest press wins, for up to 3 s) and sends it the instant you are free. Off-global spells like Counterspell still go immediately; ground-targeted spells are not queued.
- **Rogue combo points and mage Shatter / Arcane Charge (0.43):** Mutilate and Sinister Strike each earn 1 combo point (max 5, not tied to a target, and they never decay); payoffs spend all of them and scale with the number spent. Shared rogue kit: Stealth, Vanish, Sprint, Kidney Shot, Kick. **Cutthroat:** Mutilate adds a small bleed (14/s for 6 s), Evasion and Adrenaline Rush are gone, **Garrote** is an instant 100 damage hit plus a 50/s bleed on a 30 s cooldown, and **Exsanguinate** (35 energy, combo payoff) deals 60 per point plus half the bleed damage still on the target, then triples current bleeds. **Duelist:** Adrenaline Rush is now a payoff: 4 s plus 1.5 s per combo point, +60% energy regeneration, 30% faster auto attacks and 2% max health per second. **Shade:** Shadowstep and Sinister Strike, no Evasion, plus **Eviscerate** (110 damage per combo point, no cooldown). Frost Nova and Deep Freeze give you **Shatter** (10 s): your next frost damaging ability does 400% more and uses it up; this replaces the old rooted/frozen vulnerability and Ice Lance shatter. Arcane Blast adds an **Arcane Charge** (max 5, 12 s) and Arcane Barrage spends them for +50% damage each (up to 3.5x). Rogue talent trees were rebuilt for the new bars; bots use Eviscerate at 4+ points.
- **Priest bars (0.42):** Warden (Discipline) has Penance in place of Greater Heal; Lightbearer (Holy) has **Holy Nova** (instant, 60-yard radius: heals every ally in sight for 130 and hurts every enemy for 80, 12 s cooldown) in place of Pain Suppression; Gloomweaver (Shadow) has **Mind Flay** (a 3 s channel of six 45-damage ticks) in place of Smite. Penance is no longer a talent.
- New abilities with the rework: Rogue **Garrote** (a bleed) and **Fan of Knives** (area hit).

- **Damage over time and aimed spells:** Shadow priests get a no-cooldown damage-over-time spell and a bigger, longer one on a cooldown (replacing Dispel Magic). Priests' healing channel (Penance) heals a friend or hurts an enemy depending on who you target. Flamestrike and Blizzard are **aimed at the cursor**: press the key to arm the spell (its slot lights up and a ring follows your pointer), then **click or press the key again to place it**; Esc, casting something else or a stun cancels. The ring only shows while a spell is armed. While steering with the right button the ring sits at the centre of the screen.

Hover any ability, buff or debuff, spec, talent or look to see numbers for your build.

## How combat works

Tab-target, a 1 s global cooldown (0.39.1; it was 1.5 s), cast times, interrupts that lock a school, crowd control with diminishing returns, line-of-sight pillars and stealth. Warriors and rogues need auto-attack on (right-click an enemy, R, or any melee ability; it is held while stealthed unless the target is within 2 yards) to build rage and deal steady damage.

- **Jumping and ground zones:** Space jumps. A jump is mostly cosmetic, but while airborne you dodge the pulses of ground zones such as Flamestrike. Dodging has a 1.5 s cooldown so hop-spamming does not work. Targeted spells (Fireball, Frostbolt, Smite...) always hit.
- **Rules worth knowing (0.23):** auto-attacks need line of sight like spells; starting another spell cancels the one you are casting (0.38.1: that includes off-global instants like Counterspell, which you can still press mid-cast); Blink works while stunned, feared or incapacitated; Polymorph is limited to one target per caster and the sheep wanders; Fireball is an instant cast on an 8 s cooldown (it was a 1.5 s cast from 0.36); warriors build rage at a third of the original rate in 0.23 and at 0.15 per damage point from 0.31; Smoke Bomb (0.33) drops a 6-yard cloud for 6 s that strips targeting from enemies inside it; melee reach is 3 yards plus a half-yard lag allowance (0.34; measured centre to centre, and it was 5 + 1.5 before); Vanish (0.37) removes every debuff, drops you out of combat, strips enemy targets off you and stealths you; Power Word: Shield and Ice Barrier draw a pale segment on the health bar for the absorb left, plus +N in the frame text (0.38.3); Scorch is a 0.6 s cast you can make while moving, and each cast has a 15% chance to give Hot Streak, making your next Pyroblast instant (0.39); an action slot glows while a proc makes it instant, e.g. Pyroblast under Hot Streak (0.39.1); mage bars (0.40): Frost has Deep Freeze in place of Blizzard and a Shatter mechanic (see 0.43); Fire has Dragon's Breath in place of Frost Nova; Arcane has Arcane Missiles (the old channel), a new instant Arcane Barrage, and its own Arcane Explosion (damage and a 40% slow) in place of Frost Nova and Ice Barrier; the Deep Freeze talent became Elemental Mastery (Frost learns Blizzard, Fire and Arcane learn Evocation); Mage tier 4 is now the Blink tier (0.38): Twin Rift (two blinks per cooldown), Phase Stride (+40% speed for 4 s after blinking) or Arcane Surge (30% faster casts for 5 s after blinking), which replaced the Cone of Cold / Evocation / Dragon's Breath tier (those abilities are gone; Flash Freeze and Inferno Heart were reworked to Frost Nova only and Elemental Fury); damage-over-time ticks no longer break fear; Polymorph (0.38) holds the sheep still, lets it turn, heals it 10% of max health every second and blocks Blink; enemy and ally nameplates show harmful effects with time left; Cheap Shot is no longer on any bar (0.37.1): while stealthed, the Sinister Strike and Mutilate slots turn into it (Duelist, Combat, Shade and Cutthroat), then turn back; Cutthroat gained Adrenaline Rush and Shade gained Evasion in the freed slot; Blind, Psychic Scream and Intimidating Shout all break when the victim takes damage (0.36.1; bots leave a lone feared or blinded enemy alone until it wakes); class balance (0.36: 1v1 bot duels across all four classes, 24 seeds a pairing, hard bots: warrior 45, mage 47 and rogue 52 wins out of 72, fights last 55-75 s and each deals about 3100-3500 damage; mage beats warrior 15-9 and loses to rogue 8-16, rogue and warrior split 12-12; Frostbolt 140, Fireball 210, Smite 170 for 25 mana, Flash Heal 160 for 70 mana, priest mana regen 6; the priest bot now moves, smites and screams like a caster when alone, and bots hunt stealthed enemies; a lone priest still loses 1v1 to every class but lasts 70-110 s and deals 500-1000) and priest balance (0.35.1: a priest could out-heal every class in 1v1 and no bot could ever kill one; Flash Heal 230 to 130 for 80 mana, Power Word: Shield absorbs 200 on a 15 s cooldown, mana regen 8 to 4, 2500 health; rogue Sinister Strike 110, Mutilate 155, Eviscerate 260 — in 24-seed bot duels the rogue, warrior and mage now all beat a priest in roughly 70-100 s); casts, ground spells and swings need the target inside a 90-degree cone in front of your character model, not just on screen: turn away and you stay targeted but cannot cast until you face it again (0.34; bots ignore it); Blink frees you from stuns, roots and slows; stealthed rogues are spotted within 2 yards (0.29), and auto-attack only swings from stealth at that range, breaking it.
- **Fog:** enemies you cannot see (stealthed or farther than 8 yards) are left out of your snapshots entirely.

## Appearance (cosmetics change how you look, nothing else)

Nothing you wear changes your stats, damage or health: every player of a class is equal, and the build that matters is your spec and talents. There is no loot and no unlocking: **all 60 cosmetics are free for everyone**.

- **Seven slots, 8-10 choices each:** *Headwear* (horned crown, winged circlet, royal and frost crowns, pointed hat, warcrest, halo, antlers, cat ears, knight helm), *Shoulders* (spiked, gilded, crystal, wolf fur, flame tufts, royal mantle, bone, emerald), *Back* (four cloaks that sway as you run, angel, bat and phoenix wings that flap, a war banner), *Weapon glow* (ember, frostbite, venom, radiance, void, storm, blood, moonlit), *Ground aura* (sun ring, frost and emerald runes, hellfire, whirlwind, cherry blossom, shadow mist, drifting embers), *Armor dye* (ten colours that recolour the whole class model) and *Companion* (orbiting fire, frost and spirit orbs, an arcane crystal, orb trios, a pale moon, a lantern).
- **Owner-only looks:** the founder account has 11 extra cosmetics (Founder's Crown, Void Horns, Dragon Pauldrons, Archon Wings, Cloak of Embers, Godfire, Throne of Light, Stormlord, Midas Gold, Crown Satellites, Mini Sun). Other players cannot pick them, and the server strips them from anyone else's build, but everyone can see them on the owner.
- **Who sees it:** everyone in the match, spectators and replays too. The menu preview updates as you pick, the picker stays open so you can try several, and **Random look** and **Clear all** are one click.
- Old saves are tidied automatically: gear ids from the earlier tier and loot system are dropped quietly and any loot you held is gone.

## Practice with bots

| Skill | What changes |
|---|---|
| Dummies | They stand still and do nothing. Good for checking numbers and visuals. |
| Easy | Slow reactions, answers about 40% of your casts with an interrupt. |
| Normal | About 0.4 s reaction, interrupts most casts. |
| Hard | About 0.16 s reaction, interrupts everything it can. |

Bots use the same commands as a human (move, target, cast), so they obey the global cooldown, range, line of sight, resources, lockouts and stealth. They path around pillars, interrupt casts, dispel crowd control off their partner, polymorph the enemy that is not the kill target, and stun or kick casters.

## Accounts, rating and the profile

Sign up in the menu (name + password). Passwords are never stored, only a salted scrypt hash, and a login lasts 30 days.

- **Rating:** everyone starts at 1000 and one rating covers every size. Elo K is 48 for your first 5 ranked games, 32 up to 20, then 24. Teams are compared by average rating. Tiers: Bronze, Silver (1100), Gold (1300), Platinum (1500), Diamond (1700), Gladiator (1900).
- **Profile:** rating, tier, peak, wins and matches, unlocks, and the Matches tab (history and replays). There is a leaderboard of every account.
- **Cosmetics:** emblems, titles and name colours unlock by matches, wins or peak rating and show on nameplates. The founder account has exclusive owner-tier ones.
- **Settings follow the account:** HUD layout and style, keybinds, sensitivity, volume, class, builds and practice options are saved to your account and applied on any device after you sign in (the page reloads once). Guests keep settings in the browser only.

## Friends, parties and duels

- **Friends:** add by name. The other side gets a request and accepts or declines; if you add someone who already asked you, you are friends straight away. The list shows who is online and what they are doing. Up to 50 friends.
- Parties and duels are described under Play modes. Invites expire on their own.
- Friend lists live on the account record; who is online is held in memory only, so presence costs no database reads.

## Replays and spectating

- The server records every command and input of a counted match (about 20-60 KB gzipped, kept 30 days). The browser re-runs the exact match on the shared simulation, so you can pause, change speed, seek, and follow any player. A replay URL (`/?replay=<id>`) can be shared with anyone.
- Replays only play on the game data they were recorded with. After a balance or rules change, older replays say so instead of showing a wrong fight.
- Spectating covers every match with a player in it except dummy training, five seconds behind live.

## Sound

All audio is synthesised live in the browser (Web Audio), so there are no sound files to download. It covers spell casts and impacts per school, melee swings, heals, crowd control, deaths, jumping, footsteps, countdown ticks, match start and result stingers, UI clicks and a quiet ambience for each arena theme. Sounds are positional (volume by distance, pan by screen position). The Esc menu has master, effects and ambience sliders, and a mute button sits on screen. Audio starts on your first click or key press, as browsers require.

## Fair play and safety

- The server decides every outcome. The client sends intents only (cast X on Y, movement input) and never decides hits, cooldowns or damage.
- Your own movement is predicted and corrected by the server. Abilities are not predicted.
- Enemies you cannot see are not sent to your browser, so wall-hacks have nothing to read.
- Cosmetics are visual only, so nothing you wear gives an advantage.
- Your password and login token only go to this site.

## For the owner (hosting and moderation)

Players do not need any of this. The game is built from the GitHub repo `TokeGG/mmoarena` and hosted on Render at https://mmoarena.onrender.com; every push to `main` redeploys it (wait for **Deploy live**, then reload with Ctrl+Shift+R).

### Environment variables (Render > Environment)

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Free Upstash Redis database so accounts, ratings, history, replays and friends survive restarts. (`KV_REST_API_URL` and `KV_REST_API_TOKEN` also work.) Without them everything lives in memory and resets on every restart or redeploy. |
| `ARENA_OWNER_CODE` | Secret that unlocks the owner tools for the founder account (see below). Without it the owner tools are off, and you should set it **before** registering `Toke`. |
| `ARENA_SECRET` | Long random string that signs the guest progress tokens. Without it a public dev secret is used and tokens can be forged. |
| `ARENA_KEY_PREFIX` | Prefix for every database key (default `wowarena:`). It lets this game share the Aim Arena Upstash database without conflicts. Do not change it once accounts exist. |
| `PORT` | Port to listen on (Render sets it itself). |

### Deploy (Render)

1. Push the **contents** of this folder so `package.json` and `render.yaml` sit at the repo root. Leave Render's Root Directory blank and commit `package-lock.json`.
2. Render: **New + > Blueprint**, pick the repo. `render.yaml` sets Node, the Virginia region, the build and start commands and the health check. Or create a Web Service by hand:

| Setting | Value |
|---|---|
| Runtime | Node |
| Region | Virginia |
| Build command | `npm install --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/healthz` |

3. Open the Render URL. One service serves the page and the WebSocket (`wss://<host>/ws`), so there is nothing else to configure and no CORS to set up. The free tier sleeps when idle.

### Upstash setup

1. Create a free Redis database at https://upstash.com.
2. Copy the REST URL and REST TOKEN.
3. Add them as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Render and redeploy.
4. Register `Toke` again with the owner code (accounts made while the database was off are gone).

The menu shows a warning while accounts are temporary, and `/api/status` reports `persistent: true` once it works.

### Owner tools

Profile > **★ Owner**, founder account only (the name `Toke`). You must also enter `ARENA_OWNER_CODE` once per session, and the name alone is never enough. Everything is checked on the server.

- **Your own style:** a free-text title (up to 24 characters), colours (gradient and glow), and a **GIF icon** (max 256x256 px and 256 KB) that shows on your nameplate and profile.
- **Accounts panel:** award owner-tier titles, emblems and colours to any player, give a friend a custom title and colours, switch on the **GIF icon ability per friend** (they then upload their own in the same place), and reset a password (a temporary password is shown once and old sessions end).
- There are no co-admins by design. Password reset is the only account recovery.

### Security measures

| Area | Protection |
|---|---|
| Authority | Server-authoritative simulation at a fixed 20 Hz tick; per-viewer snapshot culling; every client message is validated. |
| Accounts | scrypt password hashes, random session tokens in a bearer header (no cookies, so no CSRF), 30-day expiry, rate-limited login and registration. |
| Owner | Founder name plus a secret code entered per session, rate-limited guesses. |
| Avatars | GIF only, checked for size and dimensions on the server and served from a separate path. |
| Replays | Stored compressed with a 30-day expiry and gated by a content hash so a stale replay never plays a wrong fight. |
| Connections | Per-socket message rate limit and message size cap. |
| Storage | All keys sit under one prefix so the database can be shared safely. |

### Running locally and tests

```bash
npm install
npm run dev:server        # game server on :8080
npm run dev:client        # Vite on http://localhost:5173 (proxies /ws to :8080)
npm run build && npm start     # production: one process serves the client and WebSocket
npm test                  # simulation, bots, builds, replays, accounts, matchmaking, friends, real WebSocket end-to-end
npm run typecheck
npm run duel              # headless bot-vs-bot win rates for every composition
npm run duel -- 30 hard   # 30 seeds per matchup, hard bots
```

`npm run duel` measures how the bots' playbook performs, not how humans will. Use it to catch broken classes and wildly lopsided numbers, then tune `shared/data/*.json`.

**Replay rule:** whenever you change simulation code (`shared/src/sim.ts` and anything it uses), bump `SIM_REVISION` in `shared/src/replay.ts`, otherwise older replays would play out differently. It is currently 3.

### Files

| Path | Role |
|---|---|
| `shared/data/*.json` | Classes, abilities, auras, specs, talents, cosmetics, arenas, tuning. All game content lives here, so a future Godot/Unity client or server can read the same files. |
| `shared/src/sim.ts` | Headless, deterministic simulation. No rendering, no I/O, no wall clock. Same seed and inputs give the same result. |
| `shared/src/replay.ts` | Recorder and runner that re-simulate a match from its commands. |
| `shared/src/build.ts` | The only place that turns specs and talents (including ability swaps) into numbers; cosmetics only decide the look. |
| `shared/src/bot.ts` | Bot AI, driven through the same commands a player uses. |
| `shared/src/geometry.ts`, `jump.ts` | Movement, collision, line of sight, jumping. Used by the server and by client prediction. |
| `shared/src/protocol.ts` | Message types and validation of untrusted client input. |
| `shared/src/accounts.ts` | Ranks, Elo, cosmetics, friends, match records (shared types and rules). |
| `server/src/index.ts` | HTTP and WebSocket entry, `/api/status`, avatars, replay download. |
| `server/src/rooms.ts` | Lobby, queues, parties, duels, rooms, spectators. |
| `server/src/matchmaking.ts` | Pairs queued players and parties into two equal teams. |
| `server/src/accounts.ts` | Accounts, sessions, owner tools, history, replays, friends, the Upstash/memory store. |
| `client/src/` | Three.js + Vite client: scene and models, HUD and HUD editor, menus, audio, spectate and replay viewer, friends panel. |
| `tests` | `shared/test`, `server/test` and `client/test`, run by `npm test`. |

### Known limits

- Numbers are a first pass and untuned, especially the 0.21 abilities and talents. Bot-vs-bot runs say mages are weak against melee and matches with a healer run long. Retune after you play.
- Matchmaking pairs players in queue order; it does not use rating yet. One rating covers 1v1, 2v2 and 3v3.
- Bots and dummies use the classic ability bar. They do not dodge ground zones, use Flamestrike, or pick specs and talents.
- Duels are 1v1 only. Spectating covers every match except dummy training; replays are saved for ranked and bot-practice matches of signed-in players.
- The 3D scene (maps, zones, replay and spectate cameras) has been built and tested through the simulation but not tuned on a real GPU yet. Characters are rounded primitives with outlines (`client/src/models.ts`); swap for glTF later.
- No combo points and no spell queueing window.
- Replays recorded before a simulation change stop playing.
