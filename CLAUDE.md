# Zane Stick — project memory

Physics-only football hitting/tackling simulator. TypeScript, Vite, Three.js (WebGL2), Vitest,
Playwright. Full design: `docs/design.md`. Sources for every number: `docs/realism-sources.md`.
Engine comparison: `docs/physics-benchmark.md`.

## Goals (priority order)
1. Anatomical accuracy and physical realism. 2. Controls and feel. 3. Performance on any hardware
(school Chromebook minimum, gaming PC maximum). 4. Graphics.

## Non-negotiable rules
- Active ragdoll (owner decision 2026-10-17, design §6.5): procedural animation generated in code sets the
  pose muscles track; the body is always simulated. No animation clips or mocap; no switch to/from ragdoll.
- Physics decides every outcome. No scripted tackles, success rolls, canned reactions, forced ragdoll.
- Bots get the same bodies, muscles and `Commands` as humans. Difficulty = reaction/decision/precision only,
  plus (owner decision 2026-10-18) "AI toughness": the bot's world support thresholds (knock, stun, held,
  tilt) may be scaled, never its body, muscles or Commands.
- Hit power (owner decision 2026-10-18) is an arcade knob: 1.0 = pure physics (must stay bit-identical);
  above 1 the athlete a hit drives back gets an extra push along it, the same rule for humans and bots.
- Injuries (owner decision 2026-10-18, design §6.6): joints break past a limit-torque tolerance and big head
  blows knock out, by physics, the same for every athlete; an injured athlete stays down for the rep. Gore is a
  stylised game effect with a Gore setting (default on). A fumbled ball may be picked up by hand. The human may
  get a tunable steer assist toward the ball carrier through Commands only, never a force on the body.
- `src/sim/**` never imports DOM, Three.js, input or `src/game`. Fixed timestep. Seeded RNG only
  (`sim/rng.ts`); no `Math.random` / `Date.now` / `performance.now` inside the sim.
- SI units everywhere.
- Support: horizontal carry only while not touching another player (zero in contact); posture support fades
  by how badly the athlete is knocked. Never pushes anyone into an opponent. Off contact it may be stronger:
  an athlete's own running, cutting, sinking or leaning never knocks him (design §6.5).
- Steer assist (owner decision 2026-10-18): the human brain may turn its move direction part way toward the
  ball carrier or a loose ball (a 0–1 setting). Through Commands only, never a force on the body.
- Catching (owner decision 2026-10-18): a ball in the air within reach of a raised hand is caught (hand snap) by a
  chance decided once as it comes, with the World's seeded RNG: very high with both hands (the diamond), lower with
  one, times factors (centred, ball speed, own speed/air/dive, opponent contact, looking at it, knock/stun); a broken
  arm's hand never catches; a muff bounces off physically and stays loose. Same rule for every athlete; bot
  difficulty changes only their aim. Numbers are game-design assumptions (realism-sources S7).
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
- `npm run dev` — Vite dev server (`?scenario=stand|push|walk|jog|sprint|cut|hit` for headless-style views,
  `&hp=2.5` sets the hit scenario's hit power,
  `?bench=1` runs the in-game benchmark)
- `npm test` — Vitest unit + fast physics tests (CI gate for deploys)
- `npm run test:realism` — the realism contract (balance, pushes, determinism, preset consistency; slow)
- `npm run test:e2e` — Playwright against the built site (screenshots in `test-results/`)
- `npm run build` — production build to `dist/`; pushes to `main` deploy to GitHub Pages
- `npm run deploy:cf` — build and deploy to Cloudflare Pages, project `zane-stick`: https://zane-stick.pages.dev.
  Uses the owner's Wrangler login on this PC (never read or copy its config). Every deploy updates BOTH: push
  `main` (GitHub Pages) and run `deploy:cf`. It also ships `functions/` (the room API, bindings in `wrangler.jsonc`).
- `npm run deploy:rooms` — deploy the multiplayer room server, Worker `zane-stick-rooms` (Durable Object `RoomDO`,
  `server/rooms/`, no workers.dev URL); deploy it before the first `deploy:cf` that ships `functions/`.
- `npm run dev:rooms` — local room server on 127.0.0.1:8787; `npm run dev` / `vite preview` proxy `/api` to it.
  The game uses its own origin's room API; `?server=<url>` overrides (GitHub Pages has no API: use
  `?server=https://zane-stick.pages.dev`). `test:e2e` starts it itself (tests/e2e/net.spec.ts).
- `npm run bench:engines` — physics engine comparison; `npx tsx bench/presets/run.ts` — per-preset cost
  at 1x/4x/6x CPU throttling (needs a build)
- `npx tsx bench/tune/run.ts <generations> <workers> <population>` — CMA-ES controller gain tuning;
  best result in `bench/out/gains-best.json`
- `npx tsx bench/tune/score.ts '<gains json>' --avg` — score one gain set; the objective is chaotic, so
  compare controller changes with `--avg` (mean over small gain perturbations), never single runs
- `npm run picker` — dev-only sound/character picker (localhost:5180); saves `art/picks.json`
- `npm run sfx:export` — copy only the picked sounds (+ volumes) into `public/sfx` and `src/game/sfx-picks.json`;
  `npm run sfx:build` regenerates the dev library in `art/sfx`; `npm run models:export` ships the skins and
  stadiums (+ inventory previews; stadiums are built by `blender -b --factory-startup --python art/blender/stadium.py`)
- `npm run typecheck`
- `npm run picker` — dev-only sound/character picker (tools/picker, never built or deployed); the owner's
  choices land in `art/picks.json` (format and validate() in `tools/picker/picks.ts`). `npm run test:picker`

## How to verify a change
1. `npm run typecheck && npm test` must pass.
2. Movement/controller changes: check measured metrics in test output (top speed, torso sway, step
   regularity) and capture frames with `npm run test:e2e`; look at the screenshots.
3. UI changes: `npm run build && npm run test:e2e`, review screenshots in `test-results/`.
4. Commit in small steps with clear messages.

## Gotchas
- Edit files with UTF-8 aware tools; Windows Python defaults to cp1252 and corrupts `·`, `²`, `—`.
- MuJoCo silently resets on divergence: `scene.stats().instabilities` must stay 0 in tests.
- Controller gains interact; after a structural controller change, re-run `bench/tune`.

## Current phase
Phase 1 (foundation and first playable). Do not start Phase 2.
Status: engine chosen (MuJoCo), anatomy, muscles, game shell, drill, presets, deployment done;
active ragdoll in the drill (ProceduralAnimator + TrackingController + World support): sprint ~10 m/s, no
falls before contact; the hand-built controller is the balance layer in contact (realism suite passes).
