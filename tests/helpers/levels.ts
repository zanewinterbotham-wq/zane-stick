// Gameplay equivalence across quality levels (tests/realism.test.ts): the same scripted scenarios on any physics
// settings, measured the same way. Also used by bench/perf/levels.ts to tune a level before it is committed.
import { createHash } from 'node:crypto';
import { DEFAULT_ATHLETE } from '../../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../../src/sim/anim/types';
import { BALL, BALL_TURF } from '../../src/sim/anatomy/equipment';
import { lob } from '../../src/sim/modes/kicks';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import { carrierVsTacklerScenario, pushScenario, standScenario, supportRunScenario } from '../../src/sim/scenarios';
import { World, type PhysicsSettings } from '../../src/sim/world';
import { collide, technique, type Side } from './contact';
import { metrics } from './scenario';

export interface LevelMetrics {
  /** Stands 10 s and survives a 50 N·s forward shove (hand controller, no assist). */
  balance: boolean;
  /** Supported sprint: top speed (m/s) and whether he stayed up for 8 s. */
  sprintTop: number; sprintUp: boolean;
  /** Sprint and a 45° cut at 4 s: stayed up, and the run's heading 1.5 s after the cut (deg, 45 = the full cut). */
  cutUp: boolean; cutDeg: number;
  /** A low drive at 8 m/s into an upright jogger at 4 m/s, over seeds: share of hits that down him, how far he is
   *  driven back (m), share that down the hitter. */
  hitDown: number; hitBack: number; hitterDown: number;
  /** A 60 yd kickoff lob: where the ball first lands (m along the kick) and its height after 3 s on the turf (m). */
  kickLand: number; kickRest: number;
  instabilities: number;
}

const run = async (sc: { setup: World['setup']; onStep?: (w: World) => void }, seconds: number, each?: (w: World) => void) => {
  const w = await World.create(mujocoEngine, sc.setup);
  let fell = false;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n && !fell; i++) { sc.onStep?.(w); w.step(); each?.(w); fell = !!metrics(w).down; }
  return { w, fell };
};

export async function levelMetrics(physics: PhysicsSettings, seeds = 8): Promise<LevelMetrics> {
  await mujocoEngine.init();
  let instabilities = 0;
  const done = (w: World) => { instabilities += w.scene.stats().instabilities; w.destroy(); };
  const st = await run(standScenario(physics, 0), 10), pu = await run(pushScenario(physics, 0, 50, 0), 4);
  const balance = !st.fell && !pu.fell; done(st.w); done(pu.w);
  let top = 0;
  const sp = await run(supportRunScenario(physics, 'sprint', { duration: 8 }), 8, (w) => (top = Math.max(top, metrics(w).speed)));
  const sprintUp = !sp.fell; done(sp.w);
  let cutDeg = 0;
  const cu = await run(supportRunScenario(physics, 'sprint', { cutAt: 4, duration: 5.5 }), 5.5, (w) => { const v = w.scene.athletes[0].state.comVel; cutDeg = Math.atan2(v[0], v[2]) * 180 / Math.PI; });
  const cutUp = !cu.fell; done(cu.w);
  const drive: Side = { speed: 8, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 95 } }, upright: Side = { speed: 4, script: technique.upright, params: { ...DEFAULT_ATHLETE, mass: 95 } };
  let hitDown = 0, hitBack = 0, hitterDown = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await collide(drive, upright, seed, physics, 2, { support: { ...DEFAULT_SUPPORT } });
    hitDown += +r.bDown / seeds; hitBack += r.bBack / seeds; hitterDown += +r.aDown / seeds; instabilities += r.instabilities;
  }
  const k = await kickLanding(physics);
  return { balance, sprintTop: top, sprintUp, cutUp, cutDeg, hitDown, hitBack, hitterDown, kickLand: k.land, kickRest: k.rest, instabilities: instabilities + k.instabilities };
}

/** The game's ball kicked off a tee as the kickoff mode lobs it (60 yd, its hang time), alone on the field. */
async function kickLanding(physics: PhysicsSettings) {
  const y0 = BALL.diameter / 2 + 0.01, d = 60 * 0.9144;
  const w = await World.create(mujocoEngine, { physics, seed: 1, assist: 0, athletes: [],
    props: [{ name: 'ball', shape: 'ellipsoid', size: [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2], mass: BALL.mass, pos: [0, y0, 0], friction: 0.8, turf: BALL_TURF }] });
  w.scene.launchProp(0, lob(d, 2.4 + 0.027 * 60, y0, [0, 1]), [-10, 0, 0]);
  let land = NaN, after = 0;
  while (w.time < 12 && after < 3) {
    w.step();
    const p = w.scene.propPose(0).pos;
    // the ball (prop 0) on the turf (seg −1)
    if (Number.isNaN(land) && w.time > 0.5 && w.scene.contacts().some((c) => Math.min(c.a.seg, c.b.seg) === -1 && Math.max(c.a.seg, c.b.seg) === 0)) land = p[2];
    if (!Number.isNaN(land)) after += w.dt;
  }
  const out = { land, rest: w.scene.propPose(0).pos[1], instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

/** State hash after 2 s of the carrier-versus-tackler collision (a hit with support, grips and hit power 1.5): equal
 *  hashes are bit-identical results. */
export async function hitHash(physics: PhysicsSettings): Promise<string> {
  await mujocoEngine.init();
  const sc = carrierVsTacklerScenario(physics, { hitPower: 1.5 }), w = await World.create(mujocoEngine, sc.setup);
  for (let i = 0, n = Math.round(2 / w.dt); i < n; i++) w.step();
  const v = w.scene.athletes.flatMap((a) => [...a.state.segPos, ...a.state.segQuat, ...a.state.qd]);
  w.destroy();
  return createHash('sha1').update(new Float64Array(v)).digest('hex');
}
