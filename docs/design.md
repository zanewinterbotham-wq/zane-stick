# Zane Stick — Design

A 3D football hitting and tackling simulator. Every movement is physically simulated: simulated
muscles act on a simulated skeleton. Nothing is animated, scripted, or rolled.

Status of this document: living. Sections marked **(Phase N)** are designed now and built later.

---

## 1. Pillars

1. **Physics is the referee.** A tackle works or fails only because of momentum, leverage, grip,
   balance and contact forces. There is no success roll anywhere in the code.
2. **Honest bodies.** Segment masses, lengths, inertias, joint ranges and strengths come from
   published human data (see `docs/realism-sources.md`). What you see is what is simulated.
3. **Readable, athletic control.** The athlete is strong, fast and balanced. When something goes
   wrong it is a whiff, a glancing blow or a tangle of limbs, never jelly. Wobble is a bug.
4. **Runs on a school Chromebook.** A plain WebGL2 page, small download, real-time physics with
   three athletes on a Celeron-class CPU. The same code scales up to a gaming PC.

Priority order when they conflict: anatomy and physical realism → controls and feel → performance
→ graphics.

## 2. Non-negotiable rules (summary)

- **Changed 2026-10-17 (owner decision):** the pure-physics locomotion controller could not keep athletes on
  their feet, so locomotion now uses an *active ragdoll* (§6.5). Procedural animation (generated in code;
  no clips or mocap) sets the pose the muscles track, and an invisible support carries the body along the
  animation's path while no one touches it. The body is always simulated; there is never a switch to or
  from a ragdoll.
- Contact is still decided by physics: during player contact the support never pushes horizontally, and
  its posture help fades by how badly the athlete is knocked. No scripted outcomes, success rolls, canned
  reactions or forced ragdoll switches.
- Bots use the same body, muscles and command vocabulary as humans. Difficulty changes reaction
  time, decision quality and precision only. **Changed 2026-10-18 (owner decision):** "AI toughness" may
  also make the bot sturdier than the player, but only through its world support thresholds (§6.5), and
  "hit power" above 1 is an arcade push on whoever a hit drives back (§6.5); hit power 1 is pure physics.
- The simulation core (`src/sim`) imports nothing from rendering, DOM or input. Fixed timestep.
  Same start state + same inputs → same result on the same machine.
- SI units everywhere (m, kg, s, N, N·m, rad).
- No penalties. **Changed 2026-10-18 (owner decision):** injuries are modeled (§6.6): joints break and heads are
  knocked out by physics loads, the same rule for every athlete; gore effects are stylised game effects with a
  Gore setting (default on).
- **Owner decisions 2026-10-18:** a fumbled ball may be picked up by hand; the human's movement may get a tunable
  steer assist toward the ball carrier, applied through Commands (the brain's intent), never as a force on the body.

## 3. Architecture

```
            ┌────────────── brains ──────────────┐
 input ──►  HumanBrain        BotBrain (AI)       │  issue Commands (shared vocabulary)
            └──────────────┬─────────────────────┘
                           ▼
                   MotorController  (body state + Commands → muscle activations, every step)
                           ▼
                   Muscles (torque limits, torque-velocity) → joint torques
                           ▼
                   PhysicsEngine (thin interface; MuJoCo/Rapier/Jolt adapters)
                           ▼
                   World state ──► renderer (Three.js), audio, camera, HUD, replay
```

Folders:

| Folder | Contents | May import |
|---|---|---|
| `src/sim/` | anatomy, muscles, controller, brains, drills, physics adapter, world loop | nothing outside `src/sim` |
| `src/game/` | browser shell: input, renderer, audio, camera, HUD, presets, panels | `src/sim`, three |
| `bench/` | engine comparison and preset benchmarks (Node + Playwright) | anything |
| `tests/` | Vitest unit and headless physics tests, Playwright e2e | anything |

The simulation can run on the main thread, in a Web Worker, or headless in Node. Phase 1 runs it on
the main thread with a fixed-step accumulator; moving it into a Worker is a Phase 4 optimisation and
needs no sim changes.

### 3.1 Fixed timestep and time scale

`World.step()` always advances exactly `dt = 1 / stepRate`. The game loop accumulates
`realElapsed × timeScale` and runs whole steps. Slow motion lowers `timeScale`; it never changes
`dt`. Physics settings (step rate, solver iterations, body detail) are applied only when a rep is
reset.

### 3.2 Determinism

All randomness inside the sim comes from a seeded PRNG owned by the world (`sim/rng.ts`). No
`Math.random`, no wall-clock reads inside the sim. Input is sampled once per physics step into a
`Commands` struct. The determinism test runs a scenario twice and compares a hash of every body
transform.

## 4. Physics engine

**MuJoCo 3.16 (official WebAssembly build, `@mujoco/mujoco`)**, chosen by benchmark — see
`docs/physics-benchmark.md`. Generalized coordinates (joints never pull apart), soft per-axis joint
limits, per-geom contact compliance, contact force readout, deterministic, fastest under CPU
throttling. Body-segment contacts use a 2-step time constant (no CCD in MuJoCo); minimum step rate
240 Hz. The scene is compiled per rep; grips are pre-allocated equality constraints. The engine sits behind
`src/sim/physics/engine.ts`, a thin interface: build a model from body/joint/geom descriptions,
apply joint torques and external forces, step, read transforms, velocities, joint angles and
contact forces. Grips are runtime constraints with a force readout so they can break.

## 5. Anatomy model

### 5.1 Source data

Segment mass fractions, center-of-mass locations and radii of gyration from de Leva (1996),
male table (adjustments of Zatsiorsky–Seluyanov). Segment lengths are scaled from de Leva's
reference stature (1.741 m) to the athlete's height. Body widths (shoulders, hips, chest depth)
use ratios from ANSUR II (2012) male means. Joint ranges from AAOS norms and Soucie et al. (2011).
Joint strengths from published isokinetic/isometric data for young athletic males, scaled to body
mass. Every number and its source lives in `docs/realism-sources.md` and in code in
`src/sim/anatomy/data.ts`, which cites the same sources.

### 5.2 Segments

**Standard detail (21 segments):** pelvis, lumbar (abdomen), thorax, neck, head; per side: clavicle
(shoulder girdle incl. scapula), upper arm, forearm, hand, thigh, shank, foot, toes.

**Minimum detail (13 segments):** pelvis, trunk (lumbar+thorax+clavicles merged), head (neck+head
merged); per side: upper arm, forearm (forearm+hand merged), thigh, shank, foot (foot+toes merged).

**Ultra (Phase 4):** adds thoracic spine segments and finger groups for grip.

Merging rule: merged segment mass = sum of masses; COM = mass-weighted COM; inertia via the
parallel-axis theorem about the merged COM. Joint ranges of a merged joint chain are the sum of the
member ranges; strengths are kept at the joint that remains. Unit tests assert total mass, COM
height and total inertia about the whole-body COM match within 0.5 % between detail levels.

### 5.3 Joints

| Joint | Type | DOF (axes) | Notes |
|---|---|---|---|
| hip | ball | flex/ext, ab/ad, int/ext rot | |
| knee | hinge + limited twist | flex, axial rot (±10°) | |
| ankle | 2-axis | dorsi/plantar, inv/ev (subtalar) | |
| toe (MTP) | hinge | flex/ext | |
| lumbar (pelvis→lumbar) | ball | flex/ext, lateral, rot | |
| thoracic (lumbar→thorax) | ball | flex/ext, lateral, rot | |
| lower neck (thorax→neck) | ball | flex/ext, lateral, rot | |
| upper neck (neck→head) | ball | flex/ext, lateral, rot | |
| sternoclavicular (thorax→clavicle) | 2-axis | elevation/depression, protraction/retraction | the moving shoulder girdle |
| shoulder (clavicle→upper arm) | ball | flex/ext, ab/ad, int/ext rot | glenohumeral share of range |
| elbow | hinge + forearm rotation | flex, pron/sup | |
| wrist | 2-axis | flex/ext, radial/ulnar dev | |

Ball joints are built as three hinge axes (an Euler sequence) so each axis has its own range,
actuator and soft limit. Limits are soft: a stiff but compliant limit spring engages over the last
~5° of range, the way connective tissue stiffens, instead of a hard stop.

### 5.4 Muscles

One actuator per joint axis, each direction with its own peak torque (hip extension is stronger than
flexion, and so on). Available torque (`src/sim/muscles.ts`):

```
T_avail(ω) = T0 × f_v(x),  x = shortening speed / ω_max
f_v(x) = (1 − x) / (1 + x / k)                 concentric, k = 0.3 (Hill curvature)
f_v(x) = 1.3 − 0.3 (1 + x) / (1 − 5x)           eccentric (lengthening), plateau 1.3 × T0
```

Controllers send **muscle targets** per actuator: target angle, target velocity, stiffness, damping and
a feed-forward torque. The muscle turns them into torque and clamps the total to T_avail in that
direction. The damping part is integrated implicitly by the engine (MuJoCo joint damping set every
step) for numerical stability, and is cut back first if it would exceed the muscle's capacity. A
learned controller would send the same targets (or a pure feed-forward torque) through the same limits.
Strength and speed sliders scale `T0` and `ω_max`; they never touch physics.
**Effort** per actuator = |applied torque| / peak; effort shading tints each segment by the largest
effort of the muscles driving it.

### 5.5 Equipment

| Item | Mass | Shape | Attached to |
|---|---|---|---|
| helmet + facemask | 1.95 kg | sphere r 0.135 m + facemask capsule | head |
| shoulder pads | 2.2 kg | box shell wider than the thorax, softer contact (solref 20 ms) | thorax |
| jersey | 0.3 kg | no collision; a hand grip on thorax/lumbar/pelvis is a jersey grab (60 ms compliance, tears at 400 N) | thorax |
| cleats | 0.32 kg each | adds to foot/toe mass; 25 mm sole + studs; turf traction μ 1.2, rotational 0.05 m | feet |

Equipment mass is added on top of body mass at its segment. All values and sources:
`docs/realism-sources.md` §S5.

### 5.6 Ground and ball

Turf: cleat-on-turf translational friction μ ≈ 1.2 (shoe–surface studies, see sources), torsional
friction from stud engagement. Ball **(Phase 2 for carrying physics; Phase 1 the carrier holds it
with grip constraints)**: regulation prolate spheroid, 0.41 kg, 0.28 m long, 0.17 m wide. The ball
is held only by hand/arm grip constraints with grip-strength limits, so a hard enough hit breaks the
grip and the ball comes out physically.

### 5.7 Player presets (Phase 3; Phase 1 has two defaults)

Position × level tables (height, mass, strength scale, speed scale) live in
`src/sim/anatomy/presets.ts`. Target top speeds (pro): WR/CB 9.6–10 m/s, RB/S 9.3–9.6, LB 9.0,
TE 8.8, QB 8.6, OL/DL 7.5–8.2. College ≈ −3 %, high school ≈ −10 %. Speed comes from the body;
the sliders only scale muscle limits.

### 5.8 Anatomy view

An x-ray toggle: bodies render translucent, with bones (segment axes), joint centers, whole-body
COM, its ground projection, base-of-support polygon, and contact force arrows (length ∝ force).

## 6. Motor control

### 6.1 Layers

1. **Brain** — `HumanBrain` (reads input) or a bot brain (`CarrierBrain` in Phase 1). Outputs `Commands`
   once per physics step through `Brain.think(perception, dt)`.
2. **Motor controller** — `MotorController.compute(view: BodyView, cmd: Commands, out: MuscleTargets)`.
   `BodyView` is the athlete's own body state (joint angles and speeds, segment poses and velocities,
   joint axes, COM) plus foot contacts. The hand-built `HandController` is the first implementation; a
   learned network can replace it per player.
3. **Body** — muscles (`MuscleSet`) + physics.

### 6.2 Commands (shared vocabulary)

See `src/sim/control/types.ts`: move direction and magnitude, facing, gait (walk/jog/sprint), contact
mode, arm reach L/R, grip L/R, wrap, shoot hands, sink depth, thrust hips, drive legs, chop feet, lean
(forward/side), head tuck, plant-to-cut, dive, carry (ball in left/right arm), and an optional aim point.

### 6.3 Hand-built controller (`src/sim/control/hand.ts`)

All of it ends in per-joint muscle targets plus feed-forward torques, limited by the muscles:

- **Standing balance**: capture-point (divergent component of motion) control chooses where the centre
  of pressure should be; the stance legs produce the matching ground force through Jacobian-transpose
  feed-forward (ankle strategy), and lateral balance shifts load between the feet.
- **Trunk**: SIMBICON-style. The pelvis is held in world orientation through the stance hip(s), which
  also cancel the swing hip's reaction torque (estimated from the swing targets, clamped to muscle
  capacity). The spine and neck get absolute targets relative to the pelvis and thorax, plus world
  feedback. Yaw torque is capped at what cleat rotational traction can transmit.
- **Gravity compensation** (Coros et al. 2010) for spine, neck, arms and the swing leg, so joint
  stiffness only corrects errors.
- **Walking / stepping**: a timed step cycle (~0.5 s steps at a brisk walk). Footholds come from
  capture-point placement: sagittal offset for the commanded speed (speed reference ramped at a human
  acceleration rate); lateral offset W/(1 + e^(ωT)) for a periodic gait (Englsberger 2015) plus drift
  correction. The swing foot follows a sin² clearance arc (lands with no downward speed), solved by
  analytic leg IK (verified against forward kinematics). Late-stance push-off plantarflexes the ankle.
  The stance knee carries the height-regulating force; the stance ankle's torque is scaled by the load
  actually on the foot.
- **Running** (above ~3 m/s): contact time ≈ 0.95/v s, cadence up to ~4.7 steps/s (Weyand et al.).
  A half-sine vertical push sized to carry body weight over the step, horizontal propulsion through the
  foot (friction- and strength-limited), Raibert foot placement, heel recovery in swing.
- **Chop feet**: quick (0.22 s) steps in place.
- **Contact behaviours**: arm reach, shoot hands and wrap reshape arm targets; grips form only where a
  hand touches something (`World.updateGrips`) and break when the constraint force exceeds grip (or
  jersey) strength; sink lowers the COM target and leans the trunk; thrust hips raises it and pulls the
  trunk upright; drive legs = sprint gait; dive = load, explode, fly phases with balance released.
- **Gains** are tuned offline by CMA-ES (`bench/tune`) over standing, walking, jogging, running, chop
  steps and pushes from four directions at several presets. They are capped for stability at a 240 Hz
  reference so every preset uses the same gains.

### 6.4 Balance assist (`World.applyAssist`)

An invisible force/torque on the pelvis and thorax that only steadies posture and supports body weight:

- Vertical force on the pelvis of `assist × 0.5 × m × g × w`; w fades from 1 to 0 as the pelvis drops
  below ~75 % of standing height, so it never holds up a falling body. At 100 % it carries half the
  body weight. Only while at least one foot touches the ground.
- Roll/pitch torque on the pelvis and thorax toward upright, with angular-rate damping.
- **Never horizontal force.** Horizontal acceleration comes only from feet on turf.
- Fades to 0 within 0.15 s when contact with another player begins; returns only after the players
  separate and the athlete has had stable footing for 0.3 s.
- Strength 0–100 % (tuning panel); the Phase 1 report gives the level needed.

Superseded for locomotion by the support in §6.5 (owner decision 2026-10-17). The assist remains as the
low-level posture help used in the realism suite and by the hand-built controller.

### 6.5 Active ragdoll: animation tracking and support (`src/sim/anim`, `World.applySupport`)

Goal: athletes run really fast (sprint ~10 m/s, like the fastest pros) and never fall on their own, so the
player thinks about hitting, not balancing; hits and tackles still come out of the physics.

- **Animator** (`src/sim/anim`): procedural, parameterised by commands and measured speed: idle / football
  stance, walk, jog, sprint (cadence and stride from speed, so planted feet do not slide), backpedal,
  shuffle, plant-and-cut, dive, contact overlays (arm reach, wrap, shoot, sink, drive, head tuck), ball
  carry, get-up. Writes an `AnimFrame` (target joint angles and speeds, per-dof gain, root target).
  The root velocity turns at up to 14 m/s² sideways at a pivot (≤ 4 m/s) falling to 8.5 m/s² from 8 m/s, and
  brakes at up to 12 / 9 m/s², all in one ellipse with the speed-up (braking hard leaves less to turn with); the
  heading turns at up to 12 rad/s. A dive launches along the commanded move (where the player steers). A swing
  foot that scuffs the turf early is drawn up out of it; one that lands late in a sprint's swing goes soft (gain
  0.1) instead of being driven through the turf (that bounce was the bunny hop); a planted foot's reach for lost
  turf is filtered (light contacts flicker step to step).
- **Tracking controller** (`src/sim/control/tracking.ts`): muscles track the frame through the same muscle
  limits as before. During contact, and while the support is faded, it blends toward the hand-built
  balance controller (`hand.ts`: capture-point stepping and push recovery), so a hit athlete steps and fights
  for balance physically.
- **Support** (`World.applySupport`, replaces `applyAssist` for tracked athletes), two levels per athlete:
  - *carry* (horizontal): force on the pelvis toward the root target velocity, capped at a human
    acceleration (8 m/s² along the run; across it as the animator's turn, in one ellipse). **Zero during player
    contact** (fades out within 0.1 s of first contact; returns after separation and 0.3 s of stable footing),
    so it never pushes anyone into an opponent.
  - *posture* (vertical weight share + upright torque on pelvis and thorax toward the root target):
    kept through contact, but fades by how badly this athlete is knocked: trunk tilt beyond ~25°, both feet
    off the turf, or a large impulse received. A hitter who drives through stays up; the athlete who gets
    blown up loses support and goes down. Zero once down; ramps back in with the get-up.
  - *off contact* (2026-10-18; everything here comes in with the carry level, so in contact the support is as
    before): a runner's weight share acts through the feet (divided by the share of time a foot is down, none in
    a stride's flight, catching a body that drops 10 cm below its target), a body rising past its target is
    braked (up to 0.5 g), the pelvis pitches with the trunk from 3 to 6 m/s and takes all of a turn's lean (as
    the animator solves the legs), and a tilt or a flight counts as a knock only within 1 s of the last contact,
    while a hit still carries him, while held, or while he is still knocked: his own running, cutting, sinking or
    leaning never knocks him. 200 seeded random 10 s runs (cuts, bends, stops, sinks, leans, shuffles): 0 falls
    and knock 0, was 7 falls per 100 and knock up to 1; flights over 0.2 s 43 per 100 runs, was 261, the longest
    0.43 s, was 0.46.
- *Contact technique* (all through muscles and contact; the carry stays zero in contact):
  - hip thrust: one press runs the whole thrust (0.8 s: lunge, drive and rise; holding changes nothing). Off
    contact it lunges forward (the carry stands in for the push off the turf, up to 10 m/s², ~1 m in 0.5 s from
    standing); in contact the legs drive ~1 body weight forward for 0.5 s, then half that to its end, and the
    arms lift what they hold;
  - pad level: driving legs push along the foot → trunk line (a low athlete drives forward and up, an upright
    one mostly up), a low drive lifts with the arms, shoot/reach arms are raised by the trunk's lean; the knock
    counts being lifted (upward force from opponents beyond 0.2 body weight unloads the feet) and a low athlete's
    base takes up to twice the impulse for the same knock;
  - grabbing: a raised hand closes on an opponent within 7 cm of its surface, a reaching arm aims at the part of
    the opponent nearest its shoulder (within 0.9 m), and a raised arm that holds an opponent rows him in
    (elbow flexion, shoulder extension, sitting back; pull 0.5 × grip strength through Jᵀ).
- *Big-hit response*: a full big hit (impulse past `bigHit`) raises the knock within about two steps (8 ms
  time constant; partial knocks 20 ms), and the stun's jolt (more than 0.05 in one step) blends the tracking
  controller into the loosened balance controller the same step (otherwise over 80 ms). Posture support
  drops below half 32 ms after first contact in a low drive at 8 m/s into a 4 m/s jogger (was 39 ms; at
  9 m/s 25 ms, was 32): the rest is the impulse itself arriving and turning his run around. A shove's
  slowly growing stun and small bumps keep the old rates.
- **Difficulty (owner decisions 2026-10-18)**, three independent axes plus hit power (Difficulty screen,
  Easy / Normal / Hard / Custom; applied from the next rep):
  - *AI toughness* (`AthleteSetup.toughness`, 1 = the player's): multiplies the bot's `bigHit` (and so its
    stun thresholds), held-knock timing and tilt fade thresholds. Its body, muscles and Commands are the
    player's. Easy 0.6, Normal 1, Hard 1.6. Hard hit (low drive at 8 m/s into a 4 m/s jogger, 12 seeds):
    downed 6 / 3 / 2 at 0.6 / 1 / 1.6.
  - *AI juking* (`carrierSkill(k)`, 0..1): 1 = the carrier as before (`DIFFICULTY.normal`, full moves);
    0 = 0.2 s slower to react, noisier, makes his move 0.8 s of time to contact early and does not burst out
    of it. Easy 0, Normal 0.5, Hard 1. A straight chase with a 0.4 s lead tackles 8 / 5 / 1 of 8 reps (was
    7 / 6 / 1 before the snappier turning; a sprint's sideways limit of 8.5 m/s² keeps a juke worth making).
  - *Steer assist* (owner decision 2026-10-18; Difficulty screen, 0–1, default 0.3): the human brain turns the
    stick's move direction that share of the way toward the ball carrier, or a loose ball, when it is within
    10 m and within ~60° of the stick (fading out at both edges). It changes only the Commands (the brain's
    intent), never forces on the body, and never steers the human's own carry.
  - *Player strength / speed*: the human's `AthleteParams.strength` and `speed`. Easy 1.2 / 1.1, else 1.
  - *Hit power* (`WorldSetup.hitPower`, 1–3, game default 1.5): an arcade knob, not physics. At 1 the
    simulation is bit-identical to having none. Above 1, each step the athlete a hit drives back (he and
    whoever he touches move, together, faster than 0.3 m/s along the push he gets; for the hitter that
    combined momentum is against his push) gets (hitPower − 1) × the contact force he received in the
    previous step, along it, half on the pelvis and half on the thorax, plus 0.5 of it upward so big hits
    lift him off the turf. Same rule for humans and bots. The support's carry stays zero in contact. Hard
    hit as above (12 seeds): the jogger travels 1.5 / 2.4 / 3.7 m in the 0.6 s after contact, peaks at
    3.2 / 4.4 / 6.6 m/s backward and is downed 3 / 9 / 8 times at 1 / 1.5 / 2.5.
- Settings (tuning panel): support strength, carry/posture fade thresholds, tracking stiffness.

### 6.6 Injuries: breaks and knockouts (`src/sim/injury.ts`, `World.updateInjury`)

Owner decision 2026-10-18: injuries are modeled, replacing "no injury modeling". Physics decides them; the same
rule applies to every athlete (bots and the human), and toughness / hit power change only what reaches the body.

- **Break:** each breakable dof's range-of-motion limit torque (`PhysicsScene.limitTorques`, the load the
  joint's passive structures carry), averaged over 10 ms, beyond its tolerance ([S6]; knee and elbow at the
  hyper-extension end, ankle inversion/eversion, shoulder, sternoclavicular "collarbone"), within 1 s of touching
  another athlete (traumatic injuries only). Tolerances × the athlete's bone strength (`AthleteSetup.boneStrength`;
  settings "Player bone strength" / "AI bone strength", 0.25–4, default 1). The end of its range that broke gives
  way by 0.6–1.0 rad (`PhysicsScene.setJointRange`, a runtime change that lasts the rep: each rep is a new world),
  so the limb dangles past where it used to stop.
- **Playing on hurt** (owner item 2026-10-18): one break does not end his rep. He goes down from the hit as physics
  decides, gets up and plays on, bots the same. A broken leg (knee, ankle) keeps 35 % of its muscle output and he
  hobbles (`injury.ts` HOBBLE: 0.4 × top speed, the bad leg's stance 0.6 × the gait's, the good leg's 1.35 ×;
  measured: 3.9 m/s from a 10.2 m/s sprint, the bad leg bearing 35–40 % of the good one's load). A broken arm (elbow,
  shoulder, collarbone) goes limp from the collarbone to the wrist: no muscle force, light damping, so it hangs and
  swings with the run; it neither reaches nor grips, and a ball carried in it moves to the other arm
  (`World.tuckBall`), or comes loose if both arms are broken. Brains plan at a hobble when lame.
- **Knockout:** the head's velocity change over 15 ms (the impact duration of [S6]), gravity removed, beyond
  10 m/s. Not gated on contact (a head driven into the turf counts).
- **Out of play** (a knockout, or both legs broken): the brain is no longer asked (Commands are neutral except a
  ball tucked in a sound arm), the support goes off for the rest of the rep (`SupportState.out`), the animator
  stays in its down pose (no get-up) and the tracking controller holds that loose pose instead of balancing; muscle
  tone fades over 0.3 s to 0.2 (knocked out) or 0.5 (legs broken). He is down by physics, so a carrier's rep ends.
- **Events:** `World.injuries` (athlete, break or KO, joint, segment, point, load, time) drive sound
  (`cues.ts`: bone crack and scream; knockout thud and ringing; a moan every 2.5–5 s while he lies there) and
  effects (`render/effects.ts`): stylised blood bursts, turf splats, a bone at the broken joint, comic stars,
  five looks the owner picks in the dev picker's Effects tab; the Gore setting (default on) turns them off.
- **Measured rates** (8 runs each, both athletes counted; headless, standard detail): sprints, cuts and dives
  alone, drill tackles, a low drive at 8 m/s into a 4 m/s jogger and a 6 m/s wrap of a 6 m/s carrier: no breaks
  and no knockouts at any hit power 1–3. A brutal head-on hit (110 kg at 9.5 m/s driving low into a 95 kg carrier
  sprinting at 9 m/s): knockouts 2 / 8 / 8 / 8 / 8 of 16 athletes at hit power 1 / 1.5 / 2 / 2.5 / 3 (the carrier
  every run from 1.5), athletes with a break 0 / 2 / 3 / 1 / 3 (collarbones, elbows, a knee, shoulders). A knee
  driven backward with 200 N·s at the joint while engaged breaks (`tests/injury.test.ts`).
- Known limit: at hit power 3 one head-on seed diverges (MuJoCo reset) with or without injuries; hit power 3 was
  already past what the solver keeps stable in that collision.


## 7. Controls

Two modes, switched with one input (toggle or hold, a setting).

- **Movement mode**: left stick/WASD walk–jog, sprint button, turn by steering. The full body stays
  live, so you can stumble and be knocked down.
- **Contact mode**: movement keeps working; action inputs become body-part controls.

### 7.1 Default bindings

Keyboard (Chromebook-safe: no F-keys, Caps Lock, Home/End/Delete, numpad, top-row keys, or
Ctrl/Alt/Search combos). Left hand: movement; right hand: body parts.

| Action | Keyboard | Controller (standard mapping) |
|---|---|---|
| Move | W A S D | Left stick |
| Sprint (movement) / drive legs (contact) | Shift (left) | RT (analog) |
| Toggle/hold Contact mode | Tab | View/Back |
| Left arm reach | J | LB |
| Right arm reach | L | RB |
| Both arms | J+L | LB+RB |
| Grip left / right | U / O | X / B |
| Wrap & squeeze | K | A |
| Shoot hands | I | Y |
| Lower / raise the pads (one control: the trunk leans and the hips sink together; a big hit raises lowered pads back to running) | Scroll up, K / scroll down, I | D-pad down or LT / D-pad up |
| Thrust hips | H | RS click (R3) |
| Lean fwd/back/left/right | Arrow keys | Right stick |
| Chop feet | C | LS click (L3) |
| Head tuck (hold; default is head up) | N | D-pad down |
| Plant to cut (left / right) | Q / E | D-pad left / right |
| Dive (whole-body move) | B | D-pad up |
| Reset rep | Enter | Start (tap) |
| Pause / menu | Escape | Start (hold 0.6 s) |
| Performance overlay | ` (Backquote) | menu |
| Anatomy view | X | menu |
| Camera (chase/helmet) | V | menu |
| Tuning panel | T | menu |
| Change quality preset | = | menu |
| Key test screen | menu | menu |

Bindings are data (`src/game/input/bindings.json`); the rebinding screen is Phase 2.

Mouse is never required. Bindings avoid combos that ghost on cheap keyboards: the left hand uses
W A S D Shift Tab Space Q E C B, the right hand J K L U I O H N and arrows; no single-row
4-key chords are needed for any technique.

### 7.2 Local two player (Phase 2)

Keyboard + controller or two controllers. Shared camera framing both athletes; split screen on
High and above.

## 8. Technique catalog

Every technique is a pattern of the commands above. The motor controller turns them into muscle
activations; physics decides the result. "Whole-body move" marks a single input that issues a
coordinated command pattern (still muscles only).

### 8.1 Tackler

| Technique | How it's performed |
|---|---|
| Break down, chop feet | Sink (partial) + chop feet while closing |
| Near foot / near shoulder | Move to aim the near hip; lean side toward the carrier |
| Sink hips | Sink |
| Shoot hands | Shoot (arms extend fast to the aim point) |
| Wrap up | Wrap: both arms adduct and flex; hands grip where they touch; grip breaks if overpowered |
| Head up, out of contact | Head up (default) + lean side |
| Shoulder strike | Lean fwd + side, thrust hips, arms back |
| Drive legs through contact | Drive legs + lean fwd after contact |
| Rugby roll tackle | Wrap + lean side + plant cut (rotates the pair) |
| Diving tackle | Dive (whole-body) + arms reach + wrap |
| Ankle tackle | Dive low + reach both arms at the feet |
| Low tackle at the thighs | Full sink + shoot + wrap |
| Strip / punch the ball | Grip on the ball arm + pull, or arm reach strike at the ball |
| Jersey drag | Grip on jersey (hand touches thorax back) + lean back + sink |
| Gang tackle | Multiple tacklers (Phase 2+) |
| Big hit through the hips | Sink → thrust hips at contact + drive legs |
| Lift and drive back | Wrap + thrust hips + drive legs |
| Use carrier momentum | Wrap + plant cut + lean side as he passes (twist/throw) |
| Shed a blocker | Shoot (strike chest), arm lockout (shoot + hold), rip (arm reach up under), swim (arm over), club (arm swing across) |
| Swat a stiff arm | Arm reach across toward the opponent's arm |

### 8.2 Ball carrier (Phase 2)

Stiff arm (arm reach toward tackler with elbow lock), spin (whole-body), juke (plant cut + lean),
lower the shoulder (sink + lean fwd + side), hurdle (whole-body jump), high and tight ball security
(both arms wrap the ball), switch ball to outside arm (whole-body hand-off between grips),
hesitation/dead leg (brief speed drop + lean), jump cut (whole-body), dip shoulder to get skinny
(lean side + sink), high step through arm tackles (high knee gait), churn legs to break a wrap
(drive legs + chop), fall forward (dive small).

### 8.3 Blocker (bot, Phase 2)

Inside hand placement (shoot to the opponent's chest inside his arms), drive block (drive legs +
lean fwd + arms locked), anchor (wide base + sink + lean fwd).

### 8.4 Extra ideas (later)

- **Hand fighting**: grips can grip arms; breaking a grip with a rip uses real arm torque.
- **Shoe-string trip**: reach a foot during a dive.
- **Hawk tackle**: wrap the far leg and roll.
- **Push-out on the sideline**: shoot + drive with a sideline-aware bot carrier.
- **Spin out of a wrap** for the carrier: whole-body spin while the tackler's grips are weak.

## 9. Bots

Roles: ball carrier, tackler, blocker. One or two per drill. Never a teammate of the human.

`BotBrain` reads only what an athlete could perceive (other bodies' positions/velocities, with a
reaction delay) and outputs `Commands`. Ball carrier brain (Phase 1, simple): run toward the goal
line, steer away from the tackler's projected intercept, random but seeded choices of when and
which way to cut so reps differ. Tackler brain (Phase 2): pursuit angle to an intercept, break down
at 3–4 m, choose technique by situation. Blocker brain (Phase 2): engage, inside hands, drive.

Difficulty (Phase 2): reaction delay (0.35 → 0.12 s), decision noise, aim precision. Never strength.

Brains are modules behind one interface (`Brain.think(perception, dt): Commands`).

## 10. Drills

| Drill | Phase |
|---|---|
| Open field 1-on-1, human tackler vs bot carrier | 1 |
| Open field 1-on-1, human carrier vs bot tackler | 2 |
| Oklahoma (human defender vs bot blocker + bot carrier, lane between bags) | 3 |
| Angle tackling on the sideline | 3 |
| Tackling dummies, sled | 3 |
| Human carrier vs two bot tacklers; human tackler vs carrier + lead blocker | 3 |
| Free sandbox | 3 |

A rep ends when the carrier is down (any segment other than hands and feet touches the ground),
goes out of bounds, or the time limit (10 s) runs out. Reset is fast: rebuild bodies at the start
pose (Phase 1: teleport reset; physical get-up comes in Phase 2). Full regulation field with
markings (120 yd × 53⅓ yd incl. end zones).

## 11. Feel

Target: physical, readable, sometimes hilarious chaos — but with strong, fast, balanced athletes.

- **Effort shading**: segments tint toward hot orange as their actuators near saturation.
- **Force-driven feedback**: camera shake, rumble and impact sound scale with measured contact
  force; huge hits (> threshold) trigger brief slow motion (a setting).
- **Anatomy view** (see 5.8).
- Further ideas: a "force ribbon" trail on the strongest contact for the last second; impact
  rings on the turf sized by force; a heartbeat-like audio pulse that rises with effort; a
  post-hit freeze-frame with the force arrow drawn; coaching "film room" replay with the grade
  overlaid.

## 12. Camera, replay, data

- Chase camera: target follows the pelvis (not the head), critically damped spring; never shakes
  with the head. Helmet camera: head position, stabilised orientation (yaw from head, pitch/roll
  heavily smoothed). Free camera in replays (Phase 3).
- Slow motion never changes `dt`.
- Replay (Phase 3) stores body transforms per step in a ring buffer.
- Impact data after each rep: closing speed (relative COM velocity along the line between COMs at
  first contact), peak contact force (max total normal force between the two athletes, 10 ms
  moving average), peak head linear acceleration in g (from head velocity, low-pass filtered at
  ~60 Hz; documented as a filtered rigid-body estimate, not a sensor reading).
- Technique grade (Phase 3, informational only).

## 13. Look and sound

Meshes generated in code from anatomy data (capsules/ellipsoids per segment sized from the same
numbers). Two fictional teams: **Harbor Gulls** (navy/white) and **Ridge Foxes** (orange/charcoal).
A rigged model can later be attached by mapping bones to segments; the renderer reads only segment
transforms, so physics stays the only driver. Sound: Web Audio synthesis (noise bursts + filtered
thumps for pads, clicks for cleats), gain from contact force, mute toggle. No sampled audio is
required; any CC0 sample used later is credited in `docs/realism-sources.md`.

### 13.1 Stadiums, the barrier and the inventory

- **Barrier** (`BARRIER` in `src/sim/drills/openField.ts`): four static, padded, collision-only boxes of the physics
  scene stand 5 m beyond the sidelines and end lines (4 m tall, 1 m thick), so nobody walks into the void. They are
  ordinary static props (`PropDesc.hidden`): athletes and the ball meet them like any body, and contact with them is
  neither ground nor player contact (no down-by-contact, no carry cut). Tests: `tests/stadium-barrier.test.ts`.
- **Stadiums** are low-poly environments built procedurally in Blender (`art/blender/stadium.py`, background mode),
  one mesh and a handful of flat colours each (under 400 KB), with a tiny pixel-art crowd strip. The padded wall in
  the art sits on the barrier. `npm run models:export` ships them to `public/models/stadiums/` and writes
  `src/game/stadiums.json` (label, pitch, preview, sky/fog/light); only the equipped one is fetched, at the next rep.
  The Open Field is the plain look with a procedural wall. Renders: `art/concepts/stadiums/<id>.png`.
  Dolphin Hills Stadium (`art/blender/stadium_dolphinhills.py`, after the owner's reference photo, under 600 KB) has
  sculpted terrain (the field and track down in a bowl, the home stand built into the slope, the ball fields and school
  on the upper levels, the sea right behind) and paints the game's field: materials named `*_decalN` (blue end zones,
  lettering, the midfield DH) get a polygon offset of layer N in `render/stadium.ts`. The camera's far plane is 1500 m
  so its sea horizon shows.
- **Inventory** (`src/game/inventory.ts`, menu in `ui.ts`): one tab per category (Skins, Stadiums; add a category by
  adding one entry to `CATEGORIES`), a card per item with preview, name, pitch, locked state and Equip. Everything is
  unlocked for now. The equipped skin and stadium persist in settings and show from the next rep.

## 14. Quality presets

Built (owner request 2026-10-18; details, measurements and what each level approximates in `performance.md`):

| Preset | Step rate | Solver iters | Body detail | Render scale | Shadows | Approximations |
|---|---|---|---|---|---|---|
| Potato | 180 Hz | 20 | Minimum | 0.5, 30 fps cap | off | solver tolerance, pyramid friction, far-bot level of detail, physics Worker |
| Low (stored as `minimum`) | 240 Hz | 20 | Minimum | 0.6 | off | none |
| Medium | 240 Hz | 30 | Standard | 0.85 | 1024 map | none |
| High | 480 Hz | 40 | Standard | 1.0 | 2048 map | none |
| Ultra | 480 Hz (High's physics, bit for bit) | 40 | Standard | 1.0, density cap 3x | 4096 map | none |
| Custom | the Graphics tab's Advanced overrides, any knob over any level |

The earlier plan for Ultra (960 Hz and an Ultra body with thoracic segments and finger groups) is not built: the
owner asked that the highest level play as today's High. First launch measures from the top of the ladder down and
picks the highest level that holds its target frame rate; changes apply at the next rep. The consistency test
(`tests/realism.test.ts`) checks every level against High within documented tolerances and Low, Medium, High and
Ultra against the pre-ladder code bit for bit.

Performance overlay (toggle): level, FPS, physics ms/frame and share of a core, render ms/frame, bodies, contacts,
step rate and physics thread, assist level.

## 15. Testing strategy

- **Unit (Vitest)**: anatomy data totals and proportions, merge invariants, joint limits, muscle
  curves, math utils.
- **Headless physics (Vitest, Node)**: standing 60 s; push recovery sweep (largest survived impulse
  per direction); walk/jog/sprint/cut top speeds; contact scenarios run N times with seeded small
  variations, judged on rates (low wrapped tackle > high arm tackle; lower pad level wins; heavier
  and faster drives lighter back). These are the realism contract: when one fails, fix physics or
  controller, never add a bonus.
- **Determinism**: same inputs → identical state hash.
- **Consistency**: scenario at each preset → outcomes within tolerance.
- **Benchmark script**: physics and render time per preset, with CPU throttling via Playwright/CDP.
- **Playwright**: load the built site, start a drill, scripted inputs, screenshots, fail on console
  errors. Screenshots are reviewed by eye.

## 16. Roadmap

**Phase 1 — foundation and first playable**
1. Setup, this doc, CLAUDE.md, engine benchmark and choice.
2. Anatomy at Standard and Minimum, muscles, equipment, anatomy view.
3. Hand-built motor controller: stand, balance, push recovery, walk/jog/sprint/cut, balance assist,
   passing tests; athletic, not wobbly (torso sway and step regularity measured, frames captured).
4. Movement and Contact modes with core body-part controls (arm reach/grip, wrap, sink, thrust,
   drive legs, lean, dive) on keyboard and controller.
5. Open-field 1-on-1: human tackler vs bot carrier, quick reset, reset input.
6. Impact readout, effort shading, rumble + camera shake, perf overlay, Minimum and High presets
   with automatic selection.
7. Tuning panel (controller gains, strength scale, assist, traction) with export.
8. GitHub Pages deployment + in-game benchmark screen with copyable results.

**Phase 2** — full move sets, either side, second bot and blocker, bot difficulty, physical get-up,
rebinding screen, local two player.
**Phase 3** — remaining drills, sandbox, position/level presets, replay, technique grade, feel pass.
**Phase 4** — full preset ladder + Custom + advanced panel, Chromebook optimisation (built early at the owner's
request, 2026-10-18: `performance.md`), Electron app with Ultra and cross-origin isolation.
**Phase 5** — learned-controller groundwork: headless training env, Gymnasium bridge, parallel envs,
reward modules (reference-motion term optional, off by default, no mocap shipped), policy export,
in-game loading per player, short end-to-end test, training guide. CPU training by default; check
AMD GPU support at phase start.
**Future (don't block)** — six-man football mode; online multiplayer. Keep the sim core free of
singletons so N athletes and network rollback stay possible.
