import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import { ScriptBrain } from '../src/sim/brains/script';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import { TrackingController } from '../src/sim/control/tracking';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World } from '../src/sim/world';
import { STD } from './helpers/scenario';

const view = (z: number, vz = 0, team: 0 | 1 = 1, x = 0): AthleteView => ({ com: [x, 1, z], comVel: [0, 0, vz], pelvis: [x, 1, z], head: [x, 1.8, z], heading: 0, down: false, hasBall: team === 1, team });
const perceive = (me: AthleteView, him: AthleteView, time = 0): Perception => ({ time, self: 0, athletes: [me, him], field: { halfWidth: 24, goalZ: 50, dirZ: 1 } });
const input = (armL: number, armR: number): HumanInput => ({ move: { x: 0, y: 1 }, torso: 0, sprint: 0, armL, armR, held: new Set(), cameraYaw: 0, aimPitch: 0 });

describe('HumanBrain bear hug', () => {
  it('both arm buttons always hug (round a man ahead, else arms out at the camera aim), hands open; one arm reaches straight', () => {
    const b = new HumanBrain();
    b.latest = input(1, 1);
    let c = b.think(perceive(view(0, 0, 0), view(1)));
    expect([c.wrap, c.hug, c.gripL, c.gripR, c.aim![2], c.face]).toEqual([true, true, false, false, 1, { x: 0, z: 1 }]);
    c = b.think(perceive(view(0, 0, 0), view(30)));                    // nobody near: the ready-to-wrap pose at the camera aim
    expect([c.wrap, c.hug, c.gripL, c.aim![2]]).toEqual([true, true, false, 1.5]);
    b.latest = input(1, 0);
    c = b.think(perceive(view(0, 0, 0), view(1)));
    expect([c.wrap, c.hug, c.gripL]).toEqual([false, false, true]);
  });
});

describe('bear hug pose (physics)', () => {
  beforeAll(() => mujocoEngine.init());
  /** Face to face, chest to chest, then both arm buttons: where the hands are (his frame: x out to my left, z away from
   *  me, from his thorax). The pads keep the thoraxes ~0.5 m apart. */
  async function hug() {
    const me = new HumanBrain();
    const w = await World.create(mujocoEngine, { physics: STD, seed: 1, assist: 0, support: { ...DEFAULT_SUPPORT },
      athletes: [{ params: DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: (p, m) => new TrackingController(p, m), brain: me },
        { params: DEFAULT_ATHLETE, pos: [0, 0, 0.45], yaw: Math.PI, team: 1, controller: (p, m) => new TrackingController(p, m), brain: new ScriptBrain((_t, _p, c) => { c.contactMode = true; }) }] });
    const a = w.athletes[0], s = w.scene.athletes[0].state, s1 = w.scene.athletes[1].state, th = a.segIndex.get('thorax')!;
    const rel = (st: { segPos: Float64Array }, n: string) => { const i = a.segIndex.get(n)!; return [0, 1, 2].map((k) => st.segPos[3 * i + k] - s1.segPos[3 * th + k]); };
    me.latest = { ...input(0, 0), move: { x: 0, y: 0 } };
    while (w.time < 0.5) w.step();
    me.latest = { ...input(1, 1), move: { x: 0, y: 0 } };
    while (w.time < 1.3) w.step();
    const segs = a.grips.map((g) => (g.target && g.target.athlete === 1 ? w.athletes[1].plan.segments[g.target.seg].name : ''));
    return { hands: [rel(s, 'handL'), rel(s, 'handR')], grips: a.grips.map((g) => g.active), segs, inst: w.scene.stats().instabilities };
  }
  it('chest to chest (trunks touching) the hands go round his sides past his middle, level, gripping his trunk', async () => {
    const h = await hug();
    for (const [k, p] of h.hands.entries()) {
      expect((k === 0 ? 1 : -1) * p[0]).toBeGreaterThan(0.2);  // each hand on its own side: left round his right
      expect(p[2]).toBeGreaterThan(0);                          // past his middle (round toward his back), not on his chest
      expect(Math.abs(p[1])).toBeLessThan(0.15);                // level with his chest, not up over his shoulders
    }
    expect(h.grips).toEqual([true, true]);
    for (const n of h.segs) expect(n).toMatch(/thorax|lumbar|trunk|pelvis/); // his back/sides, not an arm
    expect(h.inst).toBe(0);
  });
});
