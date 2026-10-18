// Scores a set of controller gains on headless scenarios. Lower is better. Used by the CMA-ES tuner.
import { DEFAULT_ATHLETE } from '../../src/sim/anatomy/body';
import { HandController, type Gains } from '../../src/sim/control/hand';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import { pushScenario, runScenario, standScenario, type Scenario } from '../../src/sim/scenarios';
import { World, type PhysicsSettings } from '../../src/sim/world';

const PHYS: PhysicsSettings = { hz: 240, iterations: 30, detail: 'standard' };

function withGains(sc: Scenario, gains: Partial<Gains>): Scenario {
  sc.setup.athletes = sc.setup.athletes.map((a) => ({ ...a, controller: (p, m) => { const c = new HandController(p, m); Object.assign(c.gains, gains); return c; } }));
  return sc;
}

interface Run { survived: number; duration: number; tilt: number; vFwd: number[]; vLat: number[]; comY: number[]; excursion: number }

async function run(sc: Scenario, duration: number): Promise<Run> {
  const w = await World.create(mujocoEngine, sc.setup);
  const a = w.athletes[0], s = w.scene.athletes[0].state;
  const ti = a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!;
  const c0 = [...s.com];
  const r: Run = { survived: duration, duration, tilt: 0, vFwd: [], vLat: [], comY: [], excursion: 0 };
  const n = Math.round(duration / w.dt);
  let tiltSum = 0;
  for (let i = 0; i < n; i++) {
    sc.onStep?.(w);
    w.step();
    const q = s.segQuat.subarray(4 * ti, 4 * ti + 4);
    const tilt = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[0] * q[0] + q[2] * q[2]))));
    tiltSum += tilt;
    if (i % 12 === 0) { r.vFwd.push(s.comVel[2]); r.vLat.push(s.comVel[0]); r.comY.push(s.com[1]); }
    r.excursion = Math.max(r.excursion, Math.hypot(s.com[0] - c0[0], s.com[2] - c0[2]));
    if (a.downBy || w.scene.stats().instabilities > 0 || !Number.isFinite(s.com[1])) { r.survived = w.time; break; }
  }
  r.tilt = tiltSum / Math.max(1, Math.round(r.survived / w.dt));
  w.destroy();
  return r;
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
const rms = (x: number[]) => Math.sqrt(mean(x.map((v) => v * v)));

export async function evaluate(gains: Partial<Gains>): Promise<{ score: number; parts: Record<string, number> }> {
  await mujocoEngine.init();
  const parts: Record<string, number> = {};
  const fall = (r: Run) => 60 * (1 - r.survived / r.duration);
  // standing
  const st = await run(withGains(standScenario(PHYS, 0), gains), 4);
  parts.stand = fall(st) + 20 * st.excursion + 3 * st.tilt;
  // locomotion: speed tracking after a 2 s ramp, lateral sway, posture, height kept
  for (const [gait, v] of [['walk', 1.6], ['jog', 4.2]] as const) {
    const r = await run(withGains(runScenario(PHYS, gait, { duration: 7 }), gains), 7);
    const k = Math.floor(r.vFwd.length * 2.5 / 7);
    const late = r.vFwd.slice(k), lat = r.vLat.slice(k);
    const sag = Math.max(0, 1.0 - Math.min(...r.comY, 1.07));
    // speed error weighted so that standing still always scores worse than trying and falling late
    parts[gait] = fall(r) + (gait === 'walk' ? 25 : 12) * Math.abs(mean(late) - v) + 3 * rms(lat) + 3 * r.tilt + 10 * sag;
  }
  // push recovery from four directions
  for (const [dir, imp] of [[0, 80], [180, 60], [90, 50], [-90, 50]] as const) {
    const r = await run(withGains(pushScenario(PHYS, dir, imp, 0), gains), 3.5);
    parts[`push${dir}`] = fall(r) + 2 * r.tilt;
  }
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, parts };
}

export { DEFAULT_ATHLETE };
