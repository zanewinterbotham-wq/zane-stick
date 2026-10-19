// In-game benchmark: physics cost with three athletes and render cost, per quality level. Used for the
// first-launch automatic level choice and for the copyable report on the benchmark screen.
import { DEFAULT_ATHLETE } from '../sim/anatomy/body';
import { ScriptBrain } from '../sim/brains/script';
import { DEFAULT_SUPPORT } from '../sim/anim/types';
import { makeController } from '../sim/drills/controllers';
import { mujocoEngine } from '../sim/physics/mujoco';
import { World } from '../sim/world';
import { PRESET_ORDER, PRESETS, type Preset, type PresetName } from './presets';
import { GameRenderer } from './render/renderer';
import { DEFAULT_SETTINGS } from './settings';

export interface BenchResult { preset: PresetName; physicsMsPerSimSecond: number; physicsRealtimeShare: number; renderMsPerFrame: number; fpsEstimate: number }

/** Three athletes jogging into each other, as in a two-bot drill, with the game's controller and support. */
async function physicsWorld(p: Preset) {
  return World.create(mujocoEngine, {
    physics: p.physics, seed: 3, assist: 0.2, support: { ...DEFAULT_SUPPORT },
    athletes: [0, 1, 2].map((i) => ({
      params: DEFAULT_ATHLETE, pos: [(i - 1) * 1.2, 0, i === 1 ? 4 : 0] as [number, number, number], yaw: i === 1 ? Math.PI : 0, team: (i === 1 ? 1 : 0) as 0 | 1,
      controller: (pl, m) => makeController(pl, m, 'tracking'),
      brain: new ScriptBrain((t, _p, c) => { if (t > 0.3) { c.gait = 'jog'; c.move = { x: 0, z: i === 1 ? -1 : 1 }; } }),
    })),
  });
}

export async function benchPhysics(p: Preset, seconds = 1.5): Promise<number> {
  const w = await physicsWorld(p);
  for (let i = 0; i < Math.round(0.3 / w.dt); i++) w.step(); // warm-up
  const n = Math.round(seconds / w.dt);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) w.step();
  const ms = performance.now() - t0;
  w.destroy();
  return ms / seconds;
}

export async function benchRender(canvas: HTMLCanvasElement, p: Preset, seconds = 1.5, skin = DEFAULT_SETTINGS.skin): Promise<number> {
  const w = await physicsWorld(PRESETS.minimum);
  const r = new GameRenderer(canvas, p.render);
  await r.setSkin(skin);
  r.setWorld(w);
  r.camera.position.set(-4, 2.5, -4); r.camera.lookAt(0, 1, 2);
  const frames: number[] = [];
  await new Promise<void>((done) => {
    let last = performance.now();
    const t0 = last;
    const tick = (now: number) => {
      w.step(); w.step();
      r.render(w);
      frames.push(now - last); last = now;
      if (now - t0 < seconds * 1000) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  r.renderer.dispose();
  w.destroy();
  frames.sort((a, b) => a - b);
  return frames[Math.floor(frames.length * 0.5)] ?? 16.7; // median frame interval
}

const result = (name: PresetName, phys: number, frame: number): BenchResult =>
  ({ preset: name, physicsMsPerSimSecond: phys, physicsRealtimeShare: phys / 1000, renderMsPerFrame: frame, fpsEstimate: 1000 / Math.max(frame, (phys / 1000) * frame + frame * 0.1) });

/** Every level (the benchmark screen and its report): all the physics first, then all the rendering (a frame's GPU
 *  work still in flight would slow the physics measured after it, most with software rendering). */
export async function runBenchmark(canvas: HTMLCanvasElement, presets: PresetName[] = PRESET_ORDER, skin = DEFAULT_SETTINGS.skin, seconds = 1): Promise<BenchResult[]> {
  await benchPhysics(PRESETS.minimum, 0.5); // the JIT warms up on this, so the first level measured is not slowed by it
  const phys: number[] = [];
  for (const name of presets) phys.push(await benchPhysics(PRESETS[name], seconds));
  const out: BenchResult[] = [];
  for (const [k, name] of presets.entries()) out.push(result(name, phys[k], await benchRender(canvas, PRESETS[name], seconds, skin)));
  return out;
}

/** A level holds up on this device when its physics leaves the frame enough time to render (a third of real time
 *  at 60 fps, half at 30) and a frame renders within its target frame rate (15 % slack). */
export function fits(r: BenchResult): boolean {
  const p = PRESETS[r.preset];
  return physicsFits(r.preset, r.physicsRealtimeShare) && r.renderMsPerFrame < 1000 / p.targetFps * 1.15;
}
const physicsFits = (name: PresetName, share: number) => share < (PRESETS[name].targetFps >= 60 ? 0.35 : 0.5);

/** Highest level that holds up (Potato when none does). */
export function chooseBest(rs: BenchResult[]): PresetName {
  return [...PRESET_ORDER].reverse().find((n) => { const r = rs.find((x) => x.preset === n); return r && fits(r); }) ?? 'potato';
}

/** First launch: from the top of the ladder down, the first level whose physics holds up, then from there down the
 *  first that also renders in time (a fast device measures one level of each, a slow one more). Potato is the floor. */
export async function autoChoose(canvas: HTMLCanvasElement, skin = DEFAULT_SETTINGS.skin): Promise<PresetName> {
  await benchPhysics(PRESETS.minimum, 0.3); // JIT warm-up
  const down = [...PRESET_ORDER].reverse().filter((n) => n !== 'potato');
  let k = 0;
  while (k < down.length && !physicsFits(down[k], (await benchPhysics(PRESETS[down[k]], 0.8)) / 1000)) k++;
  for (; k < down.length; k++) if (await benchRender(canvas, PRESETS[down[k]], 0.8, skin) < 1000 / PRESETS[down[k]].targetFps * 1.15) return down[k];
  return 'potato';
}

export function reportText(rs: BenchResult[]): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lines = [
    'Zane Stick benchmark',
    `browser: ${navigator.userAgent}`,
    `cores: ${navigator.hardwareConcurrency ?? '?'}  memory: ${nav.deviceMemory ?? '?'} GB  screen: ${screen.width}x${screen.height} @${devicePixelRatio}x`,
    `gpu: ${gpu}`,
    ...rs.map((r) => `${PRESETS[r.preset].label.padEnd(7)} physics ${PRESETS[r.preset].physics.hz} Hz x3 athletes: ${r.physicsMsPerSimSecond.toFixed(0)} ms per sim-second (${(r.physicsRealtimeShare * 100).toFixed(0)}% of real time); render: ${r.renderMsPerFrame.toFixed(1)} ms/frame (~${(1000 / r.renderMsPerFrame).toFixed(0)} fps)${fits(r) ? '' : '  (too slow here)'}`),
    `chosen: ${PRESETS[chooseBest(rs)].label}`,
  ];
  return lines.join('\n');
}
