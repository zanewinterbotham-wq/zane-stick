# Passing: the QB 1-on-1 mode and throw schemes (owner request 2026-10-19)

A quarterback, one receiver and one cornerback. The human plays any of the three (a mode option; any slot in
multiplayer). The owner wants several QB throwing control schemes, switchable while playing, to test them all.

## Sim contract (src/sim; bots and humans use the same Commands)

```ts
// src/sim/control/types.ts
/** Throw the ball held now so it arrives at `at` (world, m; y ≈ catch height); loft 0 = the flattest, fastest
 *  throw the arm allows (a bullet) .. 1 = a high touch lob. One-shot: set for the step(s) it is pressed; the world
 *  plays the throwing motion and releases once, and ignores more until the motion is over. */
export interface PassCmd { at: Vec3; loft: number }
interface Commands { /* … */ pass: PassCmd | null }   // neutralCommands: null

// src/sim/brains/human.ts
interface HumanInput { /* … */ pass?: PassCmd | null }  // the shell sets it on the frame a scheme triggers a throw
```

- `src/sim/throw.ts` (pure, used by the World, bots and the shell's aim previews):
  - `throwVelocity(from: Vec3, at: Vec3, loft: number): { vel: Vec3; time: number }` — the launch velocity that
    reaches `at`, clamped to what an arm can throw (an elite QB ~27 m/s release; document the source).
  - `leadPoint(from: Vec3, target: { pos: Vec3; vel: Vec3 }, loft: number): Vec3` — where to throw so a receiver
    running on at his velocity meets the ball (iterate flight time ↔ lead).
- The World throws through the athlete: the throwing arm cocks and whips (procedural animation), and at release the
  hand's grip lets go and the ball is launched (`launchProp`) with the velocity plus a spiral spin, from the hand's
  position. Accuracy error (seeded RNG): grows with distance, throwing on the run, a knock, a defender on the passer,
  and with loft. `Play.lastPass` records the throw (target, loft, speed, error, time) for the HUD and tests.
- Rules: one forward pass from behind the line of scrimmage (a pass command beyond it, or a second one, is
  ignored); a pass that touches the turf before anyone catches it is incomplete (dead ball, rep over); caught by
  the defense is an interception (he runs it back); a catch (the existing catch rule and chance) makes the receiver
  the carrier; then the usual NFL rules (down by contact, out of bounds, touchdown).
- Mode `pass` ("QB 1-on-1"): slots QB, WR (team 0) and CB (team 1). Options: your role (QB / WR / CB: that slot is
  athlete 0 in single player), the bot receiver's route (go, slant, out, in, curl, post, corner, random), coverage
  (press or off), line of scrimmage yard line, time limit. Bot QB reads the receiver's separation and throws with a
  lead; bot WR runs the route then plays the ball (dropPoint) and runs after the catch; bot CB covers man to man,
  plays the ball in the air (hands to it: an interception is a catch; a swat is a contact) and tackles after the
  catch. Difficulty only changes their reaction and precision.
- Multiplayer: `PassCmd` goes through the input codec (src/sim/net/input.ts) and `Play.lastPass` through the snapshot.

## AI built for 11 on 11 (owner request 2026-10-19)

The QB, receiver and cornerback brains must not be 1-on-1 special cases: they are the first members of a football
AI layer that later runs 11 on 11 (later phases), so they take their job as data and read the whole field.

- **Assignments as data**: a play call gives every athlete an assignment (src/sim/brains/assign.ts or similar):
  `route` (a route from a route tree: stem, break, depth, option breaks vs man/zone, sideline/hash aware, from any
  alignment: wide, slot, tight, backfield), `pass` (QB: drop type, a progression = ordered list of targets with the
  read/key for each, hot route, check-down, scramble rules), `man` (cover athlete i: press/off, inside/outside
  leverage, trail/bail technique, help over the top), `zone` (a zone: flat, hook/curl, deep third/half/quarter,
  pattern-match rules), `block` / `rush` (for later linemen), `run` (ball carrier). The 1-on-1 mode is one play call
  of three assignments; nothing in a brain may assume there is only one receiver or one defender.
- **QB**: reads the progression in order on a clock (each read's time), checks the target's openness against every
  defender (separation, leverage, closing speed, a defender in the throwing lane, the safety's depth), throws with
  lead and loft chosen for the window (bullet into a tight window, touch over an underneath defender), feels pressure
  (any defender within a radius from any side) and slides/steps up or scrambles, throws away (out of bounds) or takes
  a sack, never throws to a covered man unless the clock forces it (difficulty: read speed, precision, nerves).
- **Receiver**: runs his route from his assignment, adjusts vs press (release), sits in zone holes / runs away from
  man, tracks and attacks the ball (back-shoulder, high point with a jump, dive), blocks for a team mate's catch.
- **Defensive back**: man or zone from the assignment, reads the QB's eyes/shoulders and the ball in the air (break
  on the throw, not before), passes off receivers in zone, plays the ball (interception or a swat) vs the man,
  tackles, and pursues as in TacklerBrain.
- **Perception**: brains read only the Perception (all athletes, the ball) through their reaction delay; shared
  pure helpers (openness, throwing lane, pursuit angle, intercept point) in one module so every brain uses the same
  football sense. Unit tests per helper, headless tests per brain with 2 receivers and 2 defenders as well as 1 v 1.

## Shell contract (src/game; QB throw schemes, switchable while playing)

Each scheme turns the player's input into `HumanInput.pass` (and draws its own aim aid). Keys 1–6 pick a scheme, V
cycles; the HUD shows the active scheme's name and its controls; the choice is saved in settings and also listed in
Settings → Controls. Schemes:

1. **Aim & charge** — hold Throw to charge power, release to throw along the camera's aim (pitch = loft); a power
   meter. Fully manual.
2. **Target lock** — the receiver has an icon; tap Throw for a bullet, hold longer for more touch; auto lead
   (`leadPoint`).
3. **Placement reticle** — a ring on the turf where the camera aims; Throw lands it there; the scroll/pads keys (or
   hold time) set the loft; an arc preview.
4. **Bullet / lob buttons** — two buttons, both aimed at the locked receiver with lead: one a bullet, one a lob.
5. **Flick** — hold Throw and flick the mouse: direction and speed of the flick set the direction and power.
6. **Auto QB** — press Throw and the game picks the lead and the loft for the open man (an assist for testing).

The Throw action: a dedicated binding (default F, gamepad RT is sprint so use Y / b3), and while the local player
holds the ball as QB, Left click also throws (the arms otherwise reach and grab). No new physics in the shell.
