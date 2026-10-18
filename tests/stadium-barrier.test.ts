// The padded barrier round the field: static boxes in the physics scene that stop athletes and the ball, so nobody
// can run into the void behind the stadium.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import { BARRIER, DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

/** Furthest any segment of athlete i has reached along `axis` (0 = x, 2 = z) in the direction `sign`. */
function reach(d: OpenFieldDrill, i: number, axis: 0 | 2, sign: 1 | -1) {
  const s = d.world.scene.athletes[i].state;
  let m = -Infinity;
  for (let k = axis; k < s.segPos.length; k += 3) m = Math.max(m, sign * s.segPos[k]);
  return m;
}

describe('stadium barrier', () => {
  for (const [name, axis, sign, limit, mx, mz] of [
    ['sideline', 0, 1, BARRIER.halfWidth, 1, 0], ['other sideline', 0, -1, BARRIER.halfWidth, -1, 0],
    ['end line', 2, 1, BARRIER.halfLength, 0, 1], ['other end line', 2, -1, BARRIER.halfLength, 0, -1],
  ] as const) {
    it(`a sprinting athlete stops at the ${name}`, async () => {
      const human = new ScriptBrain((_t, _p, c) => { c.move = { x: mx, z: mz }; c.gait = 'sprint'; });
      const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD }, human);
      // the bot stands his ground, out of the way
      d.brains[d.carrier] = new ScriptBrain(() => {});
      let far = -Infinity;
      for (let i = 0, n = Math.round(14 / d.world.dt); i < n; i++) { d.step(); far = Math.max(far, reach(d, d.human, axis, sign)); }
      console.log(`${name}: reached ${far.toFixed(2)} m of ${limit.toFixed(2)} m, instabilities`, d.world.scene.stats().instabilities);
      expect(far).toBeGreaterThan(limit - 1.5);            // it did run to the wall
      expect(far).toBeLessThan(limit + 0.15);              // and no further than a soft contact's give
      expect(d.world.scene.stats().instabilities).toBe(0);
      expect(d.world.scene.athletes[d.human].state.com[1]).toBeGreaterThan(0.05); // nobody fell through the world (lying on the turf after slamming the wall is fine)
    }, 60_000);
  }

  it('stops the ball carrier and the ball he carries', async () => {
    const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD }, new ScriptBrain(() => {}));
    d.brains[d.carrier] = new ScriptBrain((_t, _p, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.carry = 2; });
    let ballZ = -Infinity;
    for (let i = 0, n = Math.round(14 / d.world.dt); i < n; i++) { d.step(); ballZ = Math.max(ballZ, d.world.scene.propPose(d.ball).pos[2]); }
    console.log('ball furthest', ballZ.toFixed(2), 'of', BARRIER.halfLength.toFixed(2));
    expect(ballZ).toBeLessThan(BARRIER.halfLength + 0.15);
    expect(reach(d, d.carrier, 2, 1)).toBeLessThan(BARRIER.halfLength + 0.15);
  }, 60_000);
});
