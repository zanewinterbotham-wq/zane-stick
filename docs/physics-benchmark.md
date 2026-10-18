# Physics engine benchmark

Run date: 2026-10-17. Machine: Ryzen 7 7800X3D, Windows 11, Node 24, Chromium (Playwright 1.64).
Reproduce: `npm run bench:engines` (Node) and `npx tsx bench/engines/throttle.ts` (browser,
1x/4x/6x CPU throttling). Raw output: `bench/out/*.json` (not committed).

## Candidates

| Engine | Package | Version | Licence | Download (gzip) |
|---|---|---|---|---|
| Rapier | `@dimforge/rapier3d-deterministic-compat` (and `-compat`) | 0.21.0 | Apache-2.0 | 1.6 MB |
| Jolt | `jolt-physics` (wasm-compat) | 1.1.0 | MIT | 0.85 MB |
| MuJoCo | `@mujoco/mujoco` (official Google DeepMind WASM bindings) | 3.16.0 | Apache-2.0 | 2.6 MB (1.9 MB brotli; 10.5 MB raw) |

MuJoCo has a maintained, official WebAssembly build (updated 2026-10-14), so it was included.

## Test humanoid

`bench/engines/humanoid.ts`: 15 bodies (pelvis, torso, head, upper arm, forearm, thigh, shank,
foot ×2), 100 kg, ball joints at spine/neck/shoulders/hips, hinges at elbows/knees/ankles, limits
on every axis where the engine supports them. Same shapes, masses, anchors and seeded random
torque sequence in every engine. Joint torques are applied the same way everywhere: equal and
opposite world-frame torques on the parent and child bodies. Each engine uses its default solver
settings unless the row says otherwise; MuJoCo uses the `implicitfast` integrator.

## Results (Node, 240 Hz unless noted)

| Engine / variant | Resting force (expect 981 N) | Motor sag, 30 N·m limit (needs 49) | Motor sag, 80 N·m | Torque stress: max joint gap | Torque stress: max segment speed | Collision: max joint gap | Collision: peak force | Deterministic | 3 humanoids ms/sim-s @120 / 240 / 480 Hz |
|---|---|---|---|---|---|---|---|---|---|
| Rapier impulse joints | 981 N | 1.63 rad (falls, correct) | 0.001 rad | **7.0 cm** | 28 m/s | 0.8 cm | 219 kN | yes | 23 / 42 / 74 |
| Rapier impulse, 8 iterations | 981 N | 1.63 | 0.001 | 3.9 cm | 35 m/s | 1.2 cm | 205 kN | yes | 33 / 58 / 108 |
| Rapier multibody joints | 981 N | 1.63 | 0.001 | 5.5 cm\* | 49 m/s | 0.0 cm | not reported | yes | 150 / 296 / 583 |
| Jolt (SwingTwist + Hinge) | **not available** | 1.61 | 0.004 | 2.7 cm | 16 m/s | 2.5 cm | **not available** | yes | 38 / 72 / 135 |
| MuJoCo, defaults | 981 N | 1.63 | 0.002 | 0.0 cm | **exploded** (6364 m/s) | 0.0 cm | 469 kN | yes | 17 / 30 / 51 |
| **MuJoCo, joint damping 1 N·m·s/rad** | 981 N | 1.54 | 0.002 | **0.0 cm** | 21 m/s | **0.0 cm** | 355 kN | **yes** | **14 / 26 / 43** |
| MuJoCo, damping + armature 0.01 | 981 N | 1.54 | 0.002 | 0.0 cm | 19 m/s | 0.0 cm | 363 kN | yes | 13 / 21 / 45 |

\*Rapier's JS API exposes no limits or motors on spherical multibody joints, so its ball joints
were unlimited in every Rapier row, which makes the torque stress harder for Rapier.

Peak force is a single-step peak between two rigid bodies with no padding; the game measures a
10 ms average and uses compliant pads, so in-game numbers will be far lower.

### Browser, CPU throttling (Chromebook stand-in), 3 humanoids, ms of CPU per simulated second

Real time needs < 1000. Lower is better.

| Engine | 1x 120/240/480 Hz | 4x 120/240/480 Hz | 6x 120/240/480 Hz |
|---|---|---|---|
| Rapier (deterministic) | 38 / 45 / 82 | 163 / 218 / 376 | 245 / 373 / 653 |
| Jolt | 40 / 73 / 137 | 205 / 370 / 691 | 337 / 617 / 1138 |
| **MuJoCo (damped)** | **16 / 27 / 45** | **77 / 138 / 243** | **134 / 242 / 427** |

At 6x throttle MuJoCo runs three humanoids at 240 Hz in 24 % of one core and at 480 Hz in 43 %,
leaving room for the controller, rendering and the browser. Jolt cannot run 480 Hz in real time
at 6x.

### Continuous collision detection

| Engine | CCD | 4 cm ball at 40 m/s into a 5 cm wall |
|---|---|---|
| Rapier | yes (`enableCcd`, plus predictive contacts) | stopped with and without CCD |
| Jolt | yes (`LinearCast` motion quality) | stopped with and without CCD |
| MuJoCo | **no** | passed through with default contact softness |

The MuJoCo pass-through is caused by its default soft contacts (20 ms time constant), not by
missed detection. With the contact time constant set to 2 timesteps, `solimp 0.95 0.99 0.001`
and a 1 cm margin, a 4 cm fist was stopped by 4 cm and 8 cm walls at 15, 25 and 40 m/s at both
240 and 480 Hz (brief overlap up to a few cm at 40 m/s; real fist and limb speeds in football are
under 25 m/s). The game uses those contact settings for body segments and softer, documented
settings for pads and helmets.

### Other criteria

| | Rapier | Jolt | MuJoCo |
|---|---|---|---|
| Joint torques applied directly | yes (`addTorque`, persists until reset) | yes | yes (`qfrc_applied` / `xfrc_applied` / motor actuators) |
| Motors with torque limits | yes, revolute + spherical per axis | yes | yes (`forcerange` on actuators) |
| Per-axis ball-joint limits | **no** in JS for spherical joints | yes (cone + twist) | yes (3 hinges or ball with cone) |
| Soft joint limits | no | yes (limit springs) | yes (`solref`/`solimp` per joint) |
| Contact force reporting | yes (events + per-point impulses) | **no** in JS bindings | yes (`mj_contactForce`, per contact) |
| Per-geom contact compliance (pads) | no (global only) | no | yes (`solref`/`solimp` per geom) |
| Constraint force readout (grip breaking) | no joint impulse readout | yes (`GetTotalLambda*`) | yes (`efc_force`) |
| Joint drift under big hits | up to 7 cm | up to 2.7 cm | none (generalized coordinates) |
| Determinism (same machine) | yes | yes | yes |
| Runs headless in Node | yes | yes | yes |
| Multithreading | no (JS) | yes (`multithread` build) | yes (`/mt` build, needs cross-origin isolation) |
| Add/remove bodies at runtime | yes | yes | no: model is compiled; rebuilt between reps |
| Biomechanics pedigree | game engine | game engine | standard tool for musculoskeletal and RL research |

## Decision: MuJoCo (official WASM build)

Reasons, in priority order:

1. **Anatomy and realism.** Generalized coordinates mean joints never pull apart, so bodies cannot
   go jelly-like in a 20 m/s collision (Rapier opened joints by 7 cm, Jolt by 2.5 cm). It also has
   per-axis soft joint limits, per-geom contact compliance for pads and helmets, accurate contact
   forces (981 N resting check), and a constraint force readout for grip breaking.
2. **Performance.** Fastest in Node and under 4x/6x throttling at every step rate.
3. **Learned controllers later.** MuJoCo is the standard engine for RL locomotion research, which
   helps Phase 5.

Costs and how they are handled:

- **No CCD.** Handled with stiff body-segment contacts (time constant = 2 steps), a small margin,
  and a minimum step rate of 240 Hz on every preset. The test above covers limb speeds.
- **Default settings exploded under extreme random torques.** Passive joint damping of
  1 N·m·s/rad fixes it and is physiological (passive joint viscosity; see `realism-sources.md`).
  In the game, torques are also velocity-limited by the muscle model.
- **The model is compiled, so bodies can't be added at runtime.** The scene is rebuilt between reps,
  which the design already requires for physics settings. Grips are pre-allocated, inactive
  equality constraints that are switched on and retargeted at runtime.
- **Download: 2.6 MB gzip, 10.5 MB raw.** If GitHub Pages doesn't compress `.wasm`, the build ships
  a gzip copy and inflates it with the browser's built-in `DecompressionStream`.
- **Windows support is marked experimental upstream.** It ran correctly in Node and Chromium on
  Windows 11 here.

Rapier is the fallback if MuJoCo hits a blocker. The engine sits behind `src/sim/physics/engine.ts`
so swapping it doesn't touch the rest of the sim.
