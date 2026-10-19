// Ball on turf: a kick landing at punt/kickoff speeds must not sink into the turf and must settle in a few seconds.
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL, BALL_TURF } from '../src/sim/anatomy/equipment';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { qrot, type Quat, type Vec3 } from '../src/sim/math';

beforeAll(() => mujocoEngine.init());

const S = [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2];
/** Height of the ball's lowest point (an ellipsoid, semi-axes S along its local axes) above the turf. */
const lowest = (pos: Vec3, q: Quat) => pos[1] - Math.hypot(...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e, k) => qrot(q, e as Vec3)[1] * S[k]));

/** A ball launched from `y0` with this velocity and spin (body frame, long axis z) until it lies still on the turf. */
export function landing(hz: number, iterations: number, vel: Vec3, spin: Vec3, y0: number, quat: Quat = [0, 0, 0, 1]) {
  const scene = mujocoEngine.createScene({ hz, iterations, athletes: [], props: [
    { name: 'ball', shape: 'ellipsoid', size: S, mass: BALL.mass, pos: [0, 5, 0], friction: 0.8, turf: BALL_TURF }] });
  scene.placeProp(0, [0, y0, 0], quat);
  scene.launchProp(0, vel, spin);
  let air = false, landed = -1, vIn = 0, vOut = 0, pen = 0, deep = 0, bounces = 0, up = false, settled = -1, prevVy = vel[1];
  for (let i = 0; i < 8 * hz; i++) {
    scene.step();
    const p = scene.propPose(0), v = scene.propVel(0), low = lowest(p.pos, p.quat), touching = scene.contacts().length > 0;
    if (low > 0.02) air = true;                                          // a kickoff leaves the tee it lies on
    if (landed < 0 && touching && air) { landed = i; vIn = -prevVy; }
    prevVy = v[1];
    if (landed < 0) continue;
    if (i - landed < 0.03 * hz) vOut = Math.max(vOut, v[1]);
    pen = Math.max(pen, -low);
    if (low < -0.01) deep += 1 / hz;                                   // time spent more than 1 cm under the turf
    if (!up && low > 0.1) { up = true; bounces++; } else if (touching) up = false;
    if (Math.hypot(...v) >= 0.1) settled = -1; else if (settled < 0) settled = (i - landed) / hz;
  }
  const p = scene.propPose(0), out = { vIn, cor: vOut / vIn, pen, deep, bounces, settled, inst: scene.stats().instabilities, x: p.pos[0], y: p.pos[1], z: p.pos[2] };
  scene.destroy();
  return out;
}

/** Landings: a flat drop from 2 m, a 45 yd punt (spiral, long axis level), a 60 yd kickoff off the tee (end over end),
 *  and 30 m/s balls coming down at 70° and 45° (a line drive: skips and tumbles furthest). */
const CASES: [string, Vec3, Vec3, number][] = [
  ['drop', [0, 0, 0], [0, 0, 0], 2 + BALL.diameter / 2],
  ['punt', [0, 20.3, 9.7], [0, 0, 40], 0.5],
  ['kickoff', [0, 19.6, 13.7], [-10, 0, 0], 0.09],
  ['hard70', [0, -28.2, 10.3], [0, 0, 40], 0.3],
  ['hard45', [0, -21.2, 21.2], [-10, 0, 0], 0.3],
];

describe('ball on turf', () => {
  for (const [preset, hz, iterations] of [['minimum', 240, 20], ['high', 480, 40]] as const) {
    it(`lands without sinking and settles (${preset})`, () => {
      for (const [name, v, w, y0] of CASES) {
        const r = landing(hz, iterations, v, w, y0), line = name === 'hard45';
        console.log(preset, name, Object.entries(r).map(([k, x]) => `${k}=${x.toFixed(3)}`).join(' '));
        expect(r.inst, name).toBe(0);
        // it can land at most one step's fall deep (it moves that far between collision checks), then is out at once
        expect(r.pen, name).toBeLessThan(r.vIn / hz + 0.01);
        expect(r.deep, name).toBeLessThanOrEqual(4 / hz + 1e-9);
        expect(r.bounces, name).toBeLessThanOrEqual(line ? 6 : 2);
        expect(r.settled, name).toBeGreaterThanOrEqual(0);
        expect(r.settled, name).toBeLessThan(line ? 6 : 3);
        if (name !== 'drop') expect(r.cor, name).toBeLessThan(0.5);
      }
    });
  }
});
