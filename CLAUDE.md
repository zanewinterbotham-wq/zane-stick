# Zane Stick — project memory

Physics-only football hitting/tackling simulator. TypeScript, Vite, Three.js (WebGL2), Vitest,
Playwright. Full design: `docs/design.md`. Sources for every number: `docs/realism-sources.md`.
Engine comparison: `docs/physics-benchmark.md`.

## Goals (priority order)
1. Anatomical accuracy and physical realism. 2. Controls and feel. 3. Performance on any hardware
(school Chromebook minimum, gaming PC maximum). 4. Graphics.

## Non-negotiable rules
- No animation clips, keyframes, or mocap playback. All motion = muscles acting on simulated bodies.
- Physics decides every outcome. No scripted tackles, success rolls, canned reactions, forced ragdoll.
- Bots get the same bodies, muscles and `Commands` as humans. Difficulty = reaction/decision/precision only.
- `src/sim/**` never imports DOM, Three.js, input or `src/game`. Fixed timestep. Seeded RNG only
  (`sim/rng.ts`); no `Math.random` / `Date.now` / `performance.now` inside the sim.
- SI units everywhere.
- Balance assist never applies horizontal force; fades out on player contact.
- If a requirement can't be met as written, stop and explain options. Never quietly substitute a shortcut.
- Physics settings change only between reps. Every body detail level preserves mass properties.
- Public repo: no personal info in code, docs, commits or settings. Free/open-source libraries only.
- When a realism test fails, fix the physics or controller. Never add a scripted bonus.

## Architecture
- `src/sim/` — physics adapter (`physics/`), anatomy (`anatomy/`), muscles, motor controller
  (`control/`), brains (`brains/`), drills, world loop. Runs in browser, Worker or Node unchanged.
- `src/game/` — browser shell: input + bindings data, renderer, camera, audio, HUD, panels, presets.
- `bench/` — engine comparison and preset benchmarks. `tests/` — unit, headless physics, e2e.
- Layers: Brain → `Commands` → MotorController → activations → Muscles → PhysicsEngine.

## Commands
- `npm run dev` — Vite dev server
- `npm test` — Vitest unit + headless physics tests
- `npm run test:e2e` — Playwright against the built site
- `npm run build` — production build to `dist/`
- `npm run bench:engines` — physics engine comparison (Node)
- `npm run typecheck`

## How to verify a change
1. `npm run typecheck && npm test` must pass.
2. Movement/controller changes: check measured metrics in test output (top speed, torso sway, step
   regularity) and capture frames with `npm run test:e2e`; look at the screenshots.
3. UI changes: `npm run build && npm run test:e2e`, review screenshots in `test-results/`.
4. Commit in small steps with clear messages.

## Current phase
Phase 1 (foundation and first playable). Do not start Phase 2.
