// In-game benchmark: physics cost with three athletes and render cost, per preset. Used for the
// first-launch automatic preset choice and for the copyable report on the benchmark screen.
import { DEFAULT_ATHLETE } from '../sim/anatomy/body';
import { ScriptBrain } from '../sim/brains/script';
import { HandController } from '../sim/control/hand';
import { mujocoEngine } from '../sim/physics/mujoco';
import { World } from '../sim/world';
import { PRESETS, type Preset, type PresetName } from './presets';
import { GameRenderer } from './render/renderer';

export interface BenchResult { preset: PresetName; physicsMsPerSimSecond: number; physicsRealtimeShare: number; renderMsPerFrame: number; fpsEstimate: number }

/** Three athletes jogging into each other, as in a two-bot drill. */
async function physicsWorld(p: Preset) {
  return World.create(mujocoEngine, {
    physics: p.physics, seed: 3, assist: 0.2,
    athletes: [0, 1, 2].map((i) => ({
      params: DEFAULT_ATHLETE, pos: [(i - 1) * 1.2, 0, i === 1 ? 4 : 0] as [number, number, number], yaw: i === 1 ? Math.PI : 0, team: (i === 1 ? 1 : 0) as 0 | 1,
      controller: (pl, m) => new HandController(pl, m),
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

export async function benchRender(canvas: HTMLCanvasElement, p: Preset, seconds = 1.5): Promise<number> {
  const w = await physicsWorld(PRESETS.minimum);
  const r = new GameRenderer(canvas, p.render);
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

export async function runBenchmark(canvas: HTMLCanvasElement, presets: PresetName[] = ['minimum', 'high']): Promise<BenchResult[]> {
  const out: BenchResult[] = [];
  for (const name of presets) {
    const p = PRESETS[name];
    const phys = await benchPhysics(p);
    const frame = await benchRender(canvas, p);
    out.push({ preset: name, physicsMsPerSimSecond: phys, physicsRealtimeShare: phys / 1000, renderMsPerFrame: frame, fpsEstimate: 1000 / Math.max(frame, (phys / 1000) * frame + frame * 0.1) });
  }
  return out;
}

/** Highest preset that holds its target frame rate with physics comfortably in real time. */
export function chooseBest(rs: BenchResult[]): PresetName {
  const high = rs.find((r) => r.preset === 'high');
  if (high && high.physicsRealtimeShare < 0.35 && high.renderMsPerFrame < 1000 / PRESETS.high.targetFps * 1.15) return 'high';
  return 'minimum';
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
    ...rs.map((r) => `${PRESETS[r.preset].label.padEnd(8)} physics ${PRESETS[r.preset].physics.hz} Hz x3 athletes: ${r.physicsMsPerSimSecond.toFixed(0)} ms per sim-second (${(r.physicsRealtimeShare * 100).toFixed(0)}% of real time); render: ${r.renderMsPerFrame.toFixed(1)} ms/frame (~${(1000 / r.renderMsPerFrame).toFixed(0)} fps)`),
    `chosen: ${chooseBest(rs)}`,
  ];
  return lines.join('\n');
}
