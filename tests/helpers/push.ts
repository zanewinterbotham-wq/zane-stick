// Push recovery: shove the thorax for 0.1 s, then require the athlete to stay up for 3 s.
import type { PhysicsSettings } from '../../src/sim/world';
import { soloWorld, metrics } from './scenario';

export async function survivesPush(dirDeg: number, impulse: number, opts: { assist?: number; physics?: PhysicsSettings; log?: boolean } = {}) {
  const w = await soloWorld(() => {}, { assist: opts.assist ?? 0, physics: opts.physics });
  const a = w.athletes[0];
  const th = a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!;
  const dir = [Math.sin((dirDeg * Math.PI) / 180), 0, Math.cos((dirDeg * Math.PI) / 180)];
  const settle = Math.round(1 / w.dt), push = Math.round(0.1 / w.dt), after = Math.round(3 / w.dt);
  for (let i = 0; i < settle; i++) w.step();
  const F = impulse / 0.1;
  for (let i = 0; i < push; i++) { w.scene.applyWrench(0, th, [dir[0] * F, 0, dir[2] * F], [0, 0, 0]); w.step(); }
  for (let i = 0; i < after; i++) {
    w.step();
    const m = metrics(w);
    if (opts.log && i % 24 === 0) console.log(`t=${w.time.toFixed(2)} com=(${m.com.map((x) => x.toFixed(2))}) v=${m.speed.toFixed(2)} tilt=${(m.tilt * 57.3).toFixed(0)}`, JSON.stringify(a.controller.debug?.()));
    if (m.down) { w.destroy(); return false; }
  }
  w.destroy();
  return true;
}

/** Largest impulse (N·s) survived in a direction, by bisection between lo (survived) and hi. */
export async function maxPush(dirDeg: number, opts: { assist?: number; physics?: PhysicsSettings } = {}) {
  let lo = 0, hi = 400;
  for (let k = 0; k < 7; k++) {
    const mid = (lo + hi) / 2;
    if (await survivesPush(dirDeg, mid, opts)) lo = mid; else hi = mid;
  }
  return lo;
}
