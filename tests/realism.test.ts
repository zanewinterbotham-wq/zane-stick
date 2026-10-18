// The realism contract (headless, Node). When one of these fails, fix the physics or the controller;
// never add a scripted bonus. Push results are also written to bench/out for the Phase 1 report.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World, type PhysicsSettings } from '../src/sim/world';
import { pushScenario, standScenario } from '../src/sim/scenarios';
import { metrics } from './helpers/scenario';

const STD: PhysicsSettings = { hz: 240, iterations: 30, detail: 'standard' };
const PRESETS: Record<string, PhysicsSettings> = {
  minimum: { hz: 240, iterations: 20, detail: 'minimum' },
  standard240: STD,
  high: { hz: 480, iterations: 40, detail: 'standard' },
};

beforeAll(() => mujocoEngine.init());

async function runFor(sc: { setup: World['setup']; onStep?: (w: World) => void }, seconds: number) {
  const w = await World.create(mujocoEngine, sc.setup);
  let maxTilt = 0, excursion = 0, fellAt = -1;
  const c0 = [...w.scene.athletes[0].state.com];
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    sc.onStep?.(w);
    w.step();
    const m = metrics(w);
    maxTilt = Math.max(maxTilt, m.tilt);
    excursion = Math.max(excursion, Math.hypot(m.com[0] - c0[0], m.com[2] - c0[2]));
    if (m.down) { fellAt = w.time; break; }
  }
  const out = { maxTilt, excursion, fellAt, instabilities: w.scene.stats().instabilities, world: w };
  return out;
}

describe('standing balance', () => {
  it('stands for 60 s with zero assist: no fall, trunk within 10°, COM within 5 cm', async () => {
    const r = await runFor(standScenario(STD, 0), 60);
    expect(r.fellAt).toBe(-1);
    expect(r.instabilities).toBe(0);
    expect(r.maxTilt * 180 / Math.PI).toBeLessThan(10);
    expect(r.excursion).toBeLessThan(0.05);
    r.world.destroy();
  });
});

describe('push recovery', () => {
  const dirs: [string, number, number][] = [['forward', 0, 60], ['backward', 180, 50], ['left', 90, 40], ['right', -90, 40]];
  const results: Record<string, number> = {};
  it.each(dirs)('survives a %s push of the stated impulse (zero assist)', async (_name, dir, impulse) => {
    const r = await runFor(pushScenario(STD, dir, impulse, 0), 4);
    expect(r.fellAt).toBe(-1);
    expect(r.instabilities).toBe(0);
    r.world.destroy();
  });
  it('records the largest push survived in each direction', async () => {
    for (const [name, dir] of dirs) {
      let lo = 0, hi = 300;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        const r = await runFor(pushScenario(STD, dir, mid, 0), 4);
        if (r.fellAt < 0) lo = mid; else hi = mid;
        r.world.destroy();
      }
      results[name] = lo;
    }
    mkdirSync('bench/out', { recursive: true });
    writeFileSync('bench/out/push-recovery.json', JSON.stringify(results, null, 2));
    expect(Object.values(results).every((v) => v >= 30)).toBe(true);
  }, 600_000);
});

describe('determinism', () => {
  it('identical setup and inputs give identical state', async () => {
    const hash = async () => {
      const r = await runFor(pushScenario(STD, 30, 70, 0.2), 3);
      const s = r.world.scene.athletes[0].state;
      const v = [...s.segPos, ...s.segQuat, ...s.q, ...s.qd];
      r.world.destroy();
      return v;
    };
    const a = await hash(), b = await hash();
    expect(a).toEqual(b);
  });
});

describe('consistency across presets', () => {
  it.each(Object.keys(PRESETS))('%s: stands 10 s and survives a 50 N·s forward push', async (name) => {
    const stand = await runFor(standScenario(PRESETS[name], 0), 10);
    expect(stand.fellAt).toBe(-1);
    stand.world.destroy();
    const push = await runFor(pushScenario(PRESETS[name], 0, 50, 0), 4);
    expect(push.fellAt).toBe(-1);
    push.world.destroy();
  });
});
