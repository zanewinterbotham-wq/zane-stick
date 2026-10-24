# Performance: quality levels and optimizations

Owner request (2026-10-18): more physics and performance settings than Minimum and High, every optimization that
helps, gameplay unchanged (or changed only behind a specific low level), and the highest level the same as today's
High. This is what was built and what it measured. Commands to reproduce are at the end.

## The ladder (src/game/presets.ts)

| Level | Physics | Graphics | Target | What changes against High |
|---|---|---|---|---|
| **Potato** | 180 Hz, 20 iterations, merged body, solver tolerance 1e-5, pyramid friction cone, far-bot level of detail (12 m), physics in a Worker | 50 % resolution, pixel density cap 1x, no shadows, low detail, no AA, 25 % injury particles, faces animate within 15 m, 30 fps cap | 30 fps | Softer contacts (2-step contact time constant at 180 Hz), a 4-sided friction pyramid instead of the cone, a looser solver, far bots re-plan every other step; hits and footing are a little different (within the tolerances below) |
| **Low** (id `minimum`) | 240 Hz, 20 iterations, merged body: today's Minimum, bit for bit, physics in a Worker | today's Minimum, faces within 30 m | 30 fps | today's Minimum |
| **Medium** | 240 Hz, 30 iterations, full body (the realism suite's standard), bit-identical to today's code at those settings, physics in a Worker | 85 % resolution, pixel cap 1.5x, shadows (1024 map), no AA | 60 fps | Half the step rate of High |
| **High** | 480 Hz, 40 iterations, full body: today's High, bit for bit | today's High | 60 fps | nothing |
| **Ultra** | High's physics, bit for bit | full pixel density (cap 3x), 4096 shadow map | 60 fps | sharper image only |

Stored settings keep their meaning: `minimum` is shown as Low and `high` is High (settings VERSION 6; an unknown id is
chosen again by the benchmark). The Graphics tab shows the ladder with a line per level and an **Advanced** section that
overrides single knobs over the chosen level (`Settings.perf`, validated against the knob lists on load): physics rate,
solver iterations, body detail, solver tolerance, friction model, far bots, physics thread; resolution, pixel density
cap, shadows, shadow quality, antialiasing, injury effects, face animation range, frame cap. Physics knobs, like the
levels, apply from the next rep. Two render-only extras follow the level (`RenderQuality.decals` / `.ao`, no Advanced
row): from Medium up, jersey numbers and names, helmet marks and the Night stadium's four floodlights (4 spot lights plus
glow sprites); on High and Ultra only, softer sun-shadow edges and soft contact shadows under feet and bodies (one
instanced draw). Always on and cheap: kicked-up turf and scuff marks (two instanced draws, scaled by the injury-effects
share), grass stains (a colour tint that builds over the session) and the crowd's sway, hops and wave (vertex shader
uniforms on the stadium's crowd material). The overlay (backquote) shows the level (marked custom when overridden), the step
rate and thread, and the physics time per frame with its share of a core.

The first-launch benchmark (src/game/benchmark.ts) measures physics from the top of the ladder down until a level's
physics leaves the frame enough time (a third of real time at 60 fps, half at 30), then rendering from there down;
Potato is the floor. The benchmark screen measures every level, all the physics first: a frame's GPU work still in
flight slowed the physics measured after it by up to 2x under software rendering.

## Gameplay equivalence (tests/realism.test.ts)

Every level runs the same scripted scenarios (tests/helpers/levels.ts) and must stay within tolerances of High: stand
10 s and take a 50 N·s shove (hand controller, no assist), sprint 8 s (top speed within 5 %), sprint and cut 45°
(within 5°), a low drive at 8 m/s into an upright jogger at 4 m/s over 16 seeds (share downed within 0.35, hitter downed
at most a quarter of the time, distance driven back within 1.5 m), and a 60 yd kickoff lob (lands within 0.3 m, settles
on the turf), with no solver divergence anywhere. Low, Medium, High and Ultra must reproduce state hashes recorded
from the code before this work (commit ee715ef) after a 2 s hit with grips and hit power 1.5: bit for bit.

Measured (16 seeds; bench/perf/levels.ts):

| Level | Top sprint (m/s) | Cut | Jogger downed | Driven back (m) | Hitter downed | Kick lands (m) |
|---|---|---|---|---|---|---|
| Potato | 10.38 | 45° | 0.19 | 4.41 | 0.06 | 54.74 |
| Low | 10.38 | 45° | 0.13 | 4.56 | 0.06 | 54.76 |
| Medium | 10.33 | 45° | 0.31 | 4.41 | 0.06 | 54.76 |
| High / Ultra | 10.34 | 45° | 0.31 | 4.71 | 0.00 | 54.76 |

(A share over 16 seeds has a standard deviation of about 0.12.) Potato with 10 solver iterations, or with MuJoCo's line
search cut to 10 iterations, diverged in the hit scenario (1–2 resets in 16 seeds) and was rejected; 20 iterations
with the default line search never diverged in 32 seeds.

## Cost

Ryzen 7 7800X3D, Windows 11, Node 24.20, headless Chromium 156. Other worktrees were running at the same time, so
every number is the fastest of several interleaved runs (process CPU time in Node).

### Headless, Node (bench/perf/sim.ts): ms of CPU per simulated second

Two scenes with the game's own setup (Play, bots on every athlete, support, hit power 1.5): the open-field tackle (2
athletes) and a kickoff return with 7 blockers and 9 coverage men (17 athletes).

| Level | Tackle, before | Tackle, after | Kickoff return 17, before | after |
|---|---|---|---|---|
| Potato | — | 42–47 | — | 208–255 |
| Low | 83 | 58 (−30 %) | 463 | 354 (−24 %) |
| Medium | — | 78 | — | 469 |
| High (= Ultra) | 182 | 151 (−17 %) | 1240 | 938 (−24 %) |

"Before" is the code at ee715ef; Low and High give the same states before and after (same hashes), so the difference is
the exact optimizations below.

### Browser, CPU throttling (bench/presets/run.ts): ms of main-thread time per simulated second

Three athletes jogging into each other (the in-game benchmark scene), SwiftShader rendering, CPU throttled with
DevTools (6x ≈ a low-end school Chromebook). Before = ee715ef's build measured the same way (physics first).

| Throttle | Potato | Low (before → after) | Medium | High (before → after) | Ultra | Auto choice |
|---|---|---|---|---|---|---|
| 1x | 65 | 92 → 68 | 82 | 182 → 145 | 147 | Ultra |
| 4x | 350 | 518 → 393 | 512 | 1140 → 974 | 994 | Low |
| 6x | 591 | 882 → 710 | 885 | 1878 → 1518 | 1544 | Potato |

Rendering is capped by vsync at 16.7 ms under SwiftShader and DevTools throttling does not slow the GPU process, so
render cost is not measured here.

The Worker is on by default for Potato, Low and Medium (owner decision 2026-10-19: Chromebooks gain the most from a
second core); High and Ultra run on the page. It is the same simulation on another thread (one frame or two more input
delay); the Advanced 'Physics thread' switch overrides it. Multiplayer hosts always run on the page.

### Physics Worker (bench/perf/worker.ts, the machine's GPU, no throttling)

| Level, scene | Page: fps, play clock | Worker: fps, play clock |
|---|---|---|
| Low, tackle | 60, 1.00x | 60, 1.00x |
| Low, kickoff return 17 | 60, 1.00x | 60, 1.00x |
| Medium, kickoff return 17 | 57, 1.00x | 60, 1.00x |
| High, tackle | 60, 1.00x | 60, 1.00x |
| High, kickoff return 17 | **11**, 0.83x | **60**, 0.79x |

When one core cannot do both, the Worker keeps the frame rate while the physics runs as fast as its core allows (the
play clock is physics-bound either way: below 1 the page drops time rather than fall behind). On a 2–4 core
Chromebook the same split gives the physics a core of its own. It costs one or two frames of input latency, hit-stop
and slow motion start a frame or two later, and the anatomy view's effort shading has no muscle data, so it is
Potato's default and an Advanced knob elsewhere ("Physics thread"). CPU throttling cannot measure it (DevTools slows
the page's thread, not the Worker's).

## What was tried

Kept, exact (bit-identical results at every level; bench/perf/sim.ts prints the state hashes):

- **Contacts read off MuJoCo's arena.** The binding copied every contact into a JS object, made two typed-array views
  and called `mj_contactForce` for each: 79 µs per step with 32 contacts. Reading the `mjContact` array where MuJoCo
  keeps it (field offsets from the binding's own views, the normal force from `efc_force`, which is what
  `mj_contactForce` returns for an elliptic cone; a pyramid's edges are summed in `mju_decodePyramid`'s order) takes
  4.6 µs. The first 50 reads per friction model are compared with the binding path; a mismatch (another MuJoCo build)
  switches the fast path off. tests/contacts-fast.test.ts compares 300 steps of each.
- **One perception per step** shared by every brain (it was rebuilt for each athlete: O(n²) with 17 athletes).
- **The animator's foothold search** (solve/reachable, up to ~15 IK trials per call, several calls per leg per step)
  without allocations, with the root's inverse orientation cached; the same arithmetic in the same order.
- **Name-to-dof lookups** in the animator done once per name instead of every step.
- **Divergence counters** (a slow binding read) read only when MuJoCo's clock went back (a reset).
- **Render:** interpolation between the last two fixed steps (smooth motion at any frame rate against the physics rate,
  the camera follows the drawn pose; render only), no per-frame tint or head-visibility work when nothing changed, far
  faces keep their expression, a frame cap per level, the pixel density cap, shadow map size and particle share per
  level. Three.js frustum culling stays on everywhere it was. The shadow camera (24 m box) follows the focused athlete and
  shadows are off on Potato and Low; scenery casts none; each stadium is one mesh with one draw call per material, the
  crowd one of them, so there is nothing left to batch.
- **Allocation-free hit bookkeeping.** The per-step hit-pair `Map` is reused and keyed by a number (not a string built per
  contact); each athlete's impulse window and the impact-force window are ring buffers that add and subtract in the
  same order as the old push/shift arrays (tests/ring-windows.test.ts compares them bit for bit).
- **Skin materials:** each athlete's clones of the skin's materials are disposed with him (they leaked GPU memory every
  rep); the shared template's are never touched.

Kept, approximate, Potato only (or an Advanced knob): 180 Hz; solver tolerance 1e-5 (MuJoCo's default is 1e-8); the
pyramid friction cone (−11 % on the tackle, −17 % on the kickoff return); athlete level of detail: a bot farther than 12 m from the ball and every opponent,
touching nobody, re-plans his motor targets every other step (over the time since his last plan) and his blended-out
balance controller rests; his muscles act on his simulated body every step from his own Commands, players' athletes
never get it (−16 % on the 17-athlete kickoff return); the Worker.

Measured and not kept:

- MuJoCo flags for unused features (spring, actuation, sensor, clamp-ctrl, friction loss): bit-identical, no gain.
- Warm start off: changes results, no gain. Island solving off: changes results and is 11 % slower (it is on by
  default in MuJoCo 3.16). Dense Jacobian: 55 % slower than the sparse one MuJoCo picks.
- CG and PGS solvers: no consistent gain over Newton with a looser tolerance; not offered.
- Line search 10 iterations, 10 solver iterations: solver divergence in hits (above).
- Collision filtering with contype/conaffinity: nothing left to filter. Each athlete has 23 geoms, the self-collision
  excludes already drop the pairs that never matter, static props never test against each other or the turf in MuJoCo,
  and the broad phase (sweep and prune plus bounding-volume trees) already skips far athletes.
- Fewer geoms at lower detail: the merged body has the same 23 geoms (mass and inertia are explicit per segment, so a
  detail level could drop geoms without changing mass properties), but every geom is a surface that hits or is hit.

Not done, and why:

- **WebAssembly threads** (measured 2026-10, tried and dropped). `@mujoco/mujoco/mt` loads and runs here (same state
  hashes), but turning its pool on (`mju_threadpool(data, 4)`, then with islands enabled, which are default-on anyway) made
  `mj_step` roughly 7-15x slower in wall time on the 2-athlete tackle and the 17-athlete kickoff return (`mj_step` went from
  about half of the step to 91-97 % of a far longer one, the controller's own cost unchanged). A step is a few hundred
  microseconds of work over mostly separate athletes; the pool's synchronization costs more than it saves. So no
  `public/_headers` is shipped: cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) would buy nothing today and cannot be tried without a real Cloudflare deploy.
  The page's own assets, fonts and room API are all same-origin, so if threads ever pay off the two headers are all that
  is needed (GitHub Pages ignores them). The Worker already takes the physics off the page's thread.
- **Instancing the athletes.** Each athlete is a few dozen meshes with per-team materials; instancing them across
  athletes needs a skinned or per-segment instanced pipeline (a renderer rewrite). The crowd is already one textured
  mesh per stadium, and the injury particles are instanced.
- **Lower controller rate for every bot**, or athlete level of detail on High: the owner asked that high-end systems
  never reduce bots.

## Reproduce

- `npx tsx bench/perf/sim.ts [seconds] [levels…] [--scene=tackle|kickoff17] [--reps=3] [--vary=[{…}]]`: Node cost
  and state hashes; `--vary` tries physics overrides.
- `npx tsx bench/perf/levels.ts [levels…] [--seeds=16] [--vary=[{…}]]`: the gameplay metrics above.
- `npm run build && PORT=4274 npx tsx bench/presets/run.ts`: the browser table (PORT when 4174 is taken).
- `npm run build && GPU=1 PORT=4274 npx tsx bench/perf/worker.ts [levels…]`: page versus Worker.
- `npx tsx bench/perf/profile.ts <file.cpuprofile>`: top functions of a `node --cpu-prof` run.
