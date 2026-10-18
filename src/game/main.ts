// Browser entry. Phase 1 scaffolding: ?scenario=stand|push|walk|jog|sprint|cut runs a named scenario.
import { mujocoEngine } from '../sim/physics/mujoco';
import { pushScenario, runScenario, standScenario, type Scenario } from '../sim/scenarios';
import { World, type PhysicsSettings } from '../sim/world';
import { ChaseCamera } from './camera';
import { GameRenderer, RENDER_PRESETS } from './render/renderer';
import { headingOf, qrot } from '../sim/math';

const params = new URLSearchParams(location.search);
const physics: PhysicsSettings = { hz: +(params.get('hz') ?? 240), iterations: 30, detail: (params.get('detail') as PhysicsSettings['detail']) ?? 'standard' };

function scenarioFromUrl(): Scenario {
  const name = params.get('scenario') ?? 'stand';
  const assist = +(params.get('assist') ?? 0);
  if (name === 'push') return pushScenario(physics, +(params.get('dir') ?? 0), +(params.get('imp') ?? 60), assist);
  if (name === 'walk' || name === 'jog' || name === 'sprint') return runScenario(physics, name, { assist });
  if (name === 'cut') return runScenario(physics, 'jog', { assist, cutAt: 3 });
  return standScenario(physics, assist);
}

async function boot() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const sc = scenarioFromUrl();
  const world = await World.create(mujocoEngine, sc.setup);
  const r = new GameRenderer(canvas, RENDER_PRESETS[(params.get('gfx') as 'minimum' | 'high') ?? 'high']);
  r.setWorld(world);
  r.setXray(params.get('xray') === '1');
  const cam = new ChaseCamera();
  cam.mode = (params.get('cam') as ChaseCamera['mode']) ?? 'chase';
  const heading = () => { const s = world.scene.athletes[0].state; const q = s.segQuat; return headingOf(qrot([q[0], q[1], q[2], q[3]], [0, 0, 1])); };
  cam.snap(r.camera, world, heading());
  window.addEventListener('resize', () => r.resize());
  document.getElementById('loading')!.remove();

  const stepOnce = () => { sc.onStep?.(world); world.step(); };
  // Deterministic hooks for Playwright frame capture: advance sim time, then render.
  const api = {
    world,
    advance(seconds: number) {
      const n = Math.round(seconds / world.dt);
      for (let i = 0; i < n; i++) stepOnce();
      cam.update(r.camera, world, seconds, heading());
      r.render(world);
      return world.time;
    },
  };
  (window as unknown as { __zs: typeof api }).__zs = api;
  if (params.get('paused') === '1') { r.render(world); return; }

  let last = performance.now(), acc = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    while (acc >= world.dt) { stepOnce(); acc -= world.dt; }
    cam.update(r.camera, world, dt, heading());
    r.render(world);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('loading');
  if (el) el.textContent = 'Failed to start: ' + (e instanceof Error ? e.message : String(e));
});
