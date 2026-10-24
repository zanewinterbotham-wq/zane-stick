# Plan: collision detail levels (for 11-on-11 and big piles)

Status: planned 2026-10-23. Do it in the next big update (owner request).

## Problem

11-on-11 lags right away, mostly because the linemen crash into each other. MuJoCo's cost grows with the number of
contact constraints (`nefc`). Ten linemen pressing together with arms, hands, shins and feet make hundreds of
limb-to-limb contacts every step, plus a solver that has to settle them all. Players never see that detail on a guard.

## Idea: per-athlete collision detail, chosen by role and importance

Every athlete keeps the same body, muscles and mass properties (CLAUDE.md: every detail level preserves mass
properties). Only what his geoms *collide with* changes:

| Level | Who | Against other athletes | Against the turf |
|---|---|---|---|
| **full** | the human player, the ball carrier, anyone near the ball or the human (configurable radius, e.g. 6 m) | every geom, as today | every geom |
| **trunk** | linemen by default, and far athletes | one proxy capsule around head + trunk + pelvis (fixed to the thorax), plus hands only while gripping | every geom (feet and limbs still stand, fall and get up normally) |
| **ghost** (optional) | very far athletes on Potato / Low | proxy capsule only | feet and trunk only |

How:
- MuJoCo `contype` / `conaffinity` bitmasks per geom. One bit for "turf", one for "athlete detail", one for "athlete
  proxy". Limb geoms at the trunk level keep only the turf bit.
- The proxy is an extra geom compiled into each athlete. It is inactive (no bits) at the full level.
- The bitmasks live in `mjModel` and can be changed at runtime (`geom_contype` / `geom_conaffinity`), so an athlete
  can move between levels mid-play. Example: a lineman who peels off toward the ball turns full. Change levels only
  at a step boundary, and only when the athlete is not in deep contact, to avoid a pop.
- Grips must still work for blockers: a hand that is gripping keeps its detail bits until it lets go.
- Pick the level in one place, e.g. `World.collisionLevel(i)`, from the mode (a `lineman: true` flag on PlayerSpec,
  or ModeDef default) plus distance to the ball and to the human. Run it at about 4 Hz, not every step.

Rules and risks:
- Linemen-vs-linemen hits become coarser: one capsule instead of limbs. That's fine for 11-on-11 linemen, but every
  drill and small mode must stay at **full**, so the feel of hits the owner tuned doesn't change.
- Low / Medium / High / Ultra must stay bit-identical in the existing scenarios. They are all full, so the change is
  gated and the recorded hashes don't move. Add new 11-on-11 hashes.
- `docs/performance.md` says global contype filtering was tried and not kept. That was a blanket change to everyone.
  This is per-role and per-distance, for modes with no recorded results.

## Other optimizations in the same spirit (detail where it's seen, coarse where it isn't)

1. **Profile 11-on-11 first.** Add an `eleven` scenario to `bench/perf/sim.ts`, with a cost breakdown (brain /
   controller / muscles / mj_step / contacts) and `nefc` per step, so each change below is measured.
2. **Coarser body plans for unimportant athletes.** Low already has a "merged segments" body detail level. Use the
   fused plan per athlete (linemen and far athletes) on every preset: fewer bodies, joints and geoms. It preserves
   mass properties, but it's a per-rep choice (the model is compiled per rep).
3. **No limb contacts within a team.** Teammates' limbs shouldn't collide with each other (only trunk proxies), and
   hands only when gripping.
4. **Cheaper contact settings for coarse pairs:** condim 1 (normal force only) for proxy–proxy and limb–limb
   contacts away from the play, and the pyramid friction cone for them, keeping condim 3/4 and the elliptic cone for
   the full level and the feet.
5. **Island solving:** MuJoCo 3.x can solve separate groups of touching bodies independently. 11-on-11 splits into
   piles, so re-test `mjENBL_ISLAND` for this mode (it wasn't a win in the drills).
6. **Controller cost:** about 40 % of a big scene's cost. Run the tracking controller at half rate for trunk-level
   athletes on Potato / Low / Medium only (the owner rule: High / Ultra never reduce bots), holding torques between
   updates.
7. **Sleep idle athletes:** athletes standing still out of the play (e.g. a DB with no one near) go kinematic, posed
   but not simulated, until something comes within a few metres or the ball does. This builds on the existing
   `activeBots` / athlete LOD.
8. **Render side:** faces (mouth and brows), shadows and skinned detail only for the nearest N athletes; simpler
   materials and no decals far away; shared geometry across athletes of the same skin.
9. **Multiplayer:** snapshots for 22 athletes are big. Send trunk-level athletes at a lower rate or with fewer joint
   angles, and let guests interpolate.

## Done when

- 11-on-11 runs in real time on the Medium preset on a mid laptop (target: ≤ 1× real-time cost at 240 Hz in
  `bench/perf/sim.ts eleven`), with no MuJoCo divergences.
- Every existing scenario's hashes are unchanged.
- The realism suite passes.
- The full-detail athletes (human, carrier, near the ball) feel the same.
