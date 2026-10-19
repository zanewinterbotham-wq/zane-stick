// The realism contract (headless, Node). When one of these fails, fix the physics or the controller;
// never add a scripted bonus. Push results are also written to bench/out for the Phase 1 report.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World, type PhysicsSettings } from '../src/sim/world';
import { pushScenario, standScenario } from '../src/sim/scenarios';
import { metrics } from './helpers/scenario';
import { hitHash, levelMetrics, type LevelMetrics } from './helpers/levels';
import { PRESET_ORDER, PRESETS as GAME, type PresetName } from '../src/game/presets';

const STD: PhysicsSettings = { hz: 240, iterations: 30, detail: 'standard' };
/** Every quality level's physics (Medium is STD). */
const PRESETS: Record<string, PhysicsSettings> = Object.fromEntries(PRESET_ORDER.map((n) => [n, GAME[n].physics]));

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

describe('gameplay equivalence across quality levels', () => {
  /** State hashes after the carrier-versus-tackler hit (helpers/levels.ts hitHash), recorded from the code before the
   *  quality ladder (commit ee715ef) on Node 24: Low, Medium (the 240 Hz standard body) and High are bit-identical
   *  to it. (A different JS engine may round Math.sin and the like differently: re-record from that commit then.) */
  const TODAY = { minimum: '64e24ac6dff4ef11083cab18bf5ad6b96acecb75', medium: 'df8824b0bf6e67a85c0c3fc1b52120e3b2d62334', high: '68893a8f46957a7ea66d946192a85e2d8f10ff4b' };
  it('Low, Medium, High and Ultra give today\'s results bit for bit (Ultra = High)', async () => {
    for (const [name, h] of Object.entries(TODAY)) expect(await hitHash(GAME[name as PresetName].physics), name).toBe(h);
    expect(await hitHash(GAME.ultra.physics)).toBe(TODAY.high);
  });
  const SEEDS = 16;
  let high: LevelMetrics;
  beforeAll(async () => { high = await levelMetrics(GAME.high.physics, SEEDS); }, 600_000);
  it.each(PRESET_ORDER.filter((n) => n !== 'high'))('%s plays like High: balance, sprint, cut, a standard hit, a kickoff landing', async (name) => {
    const m = name === 'ultra' ? high : await levelMetrics(GAME[name].physics, SEEDS);
    console.log(name, JSON.stringify(m), 'high', JSON.stringify(high));
    expect(m.instabilities).toBe(0);
    expect(m.balance).toBe(true);
    expect(m.sprintUp && m.cutUp).toBe(true);
    expect(Math.abs(m.sprintTop - high.sprintTop)).toBeLessThan(0.05 * high.sprintTop);
    expect(Math.abs(m.cutDeg - 45)).toBeLessThan(5);
    // the hit: rates over 16 seeds (a binomial share's sd is ~0.12 there), the distance he is driven back
    expect(Math.abs(m.hitDown - high.hitDown)).toBeLessThan(0.35);
    expect(m.hitterDown).toBeLessThanOrEqual(0.25);
    expect(Math.abs(m.hitBack - high.hitBack)).toBeLessThan(1.5);
    // the kick flies the same and lands within a ball length; it settles on the turf (on its side or its tip)
    expect(Math.abs(m.kickLand - high.kickLand)).toBeLessThan(0.3);
    expect(m.kickRest).toBeLessThan(0.16);
  }, 900_000);
});
