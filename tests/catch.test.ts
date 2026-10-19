// Catching (owner decision 2026-10-18): a ball within reach of a raised hand is caught (hand snap), the same rule for
// every athlete; one over a hand that is not raised bounces off. The human's raised hands go to a ball flying at him,
// and a dive lays him out to one beyond his reach. Scripted, headless and deterministic.
import { beforeAll, describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Commands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import type { Brain } from '../src/sim/brains/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const G = 9.81;
const script = (fn: (t: number, c: Commands) => void) => new ScriptBrain((t, _p, c) => fn(t, c));
const still = () => script(() => {});
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 0 }, torso: 0, sprint: 0, sink: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });
async function drill(human: Brain) { return OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD }, human, 0); }
function run(d: OpenFieldDrill, seconds: number, each?: () => boolean | void) {
  const end = d.repTime + seconds;
  while (d.repTime < end && !d.ended) { d.step(); if (each?.()) break; }
}
/** The bot lets go of the ball and it is thrown along −z (at the human, who faces +z) to pass through `at` in T s,
 *  from `dist` m beyond it, at vy m/s there (0: the top of its arc); the bot then stands still. */
function throwThrough(d: OpenFieldDrill, at: Vec3, dist: number, T: number, vy = 0) {
  const w = d.world, vy0 = vy + G * T;
  w.releaseGrip(d.carrier, 1);
  w.scene.placeProp(d.ball, [at[0], at[1] - vy0 * T + G * T * T / 2, at[2] + dist], [0, 0, 0, 1]);
  w.scene.launchProp(d.ball, [0, vy0, -dist / T], [0, 0, 0]);
  d.step();
  expect(d.world.ballCarrier).toBe(-1);
  d.brains[d.carrier] = still();
}
const hand = (d: OpenFieldDrill, h: 0 | 1) => d.world.handPoint(d.world.athletes[d.human], h);
/** A hand `off` m further out than it is (along the line from the other hand, level). */
function wide(d: OpenFieldDrill, h: 0 | 1, off: number): Vec3 {
  const a = hand(d, h), b = hand(d, h === 0 ? 1 : 0), dx = a[0] - b[0], dz = a[2] - b[2], n = Math.hypot(dx, dz) || 1;
  return [a[0] + dx / n * off, a[1], a[2] + dz / n * off];
}

describe('catching', () => {
  it('the human holding both arm buttons catches a ball thrown at him: his hands go to it', async () => {
    const human = new HumanBrain();
    human.latest = input({ armL: 1, armR: 1 });
    const d = await drill(human);
    run(d, 0.6);
    const s = d.world.scene.athletes[d.human].state;
    throwThrough(d, [s.com[0] + 0.4, s.com[1] + 0.5, s.com[2] + 0.3], 6, 0.5); // at the right shoulder
    let closest = Infinity;
    run(d, 1.5, () => { const b = d.ballPos(), h = hand(d, 0); closest = Math.min(closest, Math.hypot(b[0] - h[0], b[1] - h[1], b[2] - h[2])); return d.world.ballCarrier >= 0; });
    console.log('thrown at a ready catcher: caught by', d.recoveredBy, 'closest left hand', closest.toFixed(2), 'm');
    expect(d.recoveredBy).toBe(d.human);
    expect(d.world.ballCarrier).toBe(d.human);
    expect(d.ended).toBe(null);
    d.destroy();
  });

  it('a ball passing 0.3 m wide of a raised hand is caught', async () => {
    const d = await drill(script((_t, c) => { c.armL = c.armR = 1; c.gripL = c.gripR = true; }));
    run(d, 0.6);
    throwThrough(d, wide(d, 1, 0.3), 4, 0.3);
    run(d, 1, () => d.world.ballCarrier >= 0);
    console.log('0.3 m wide of a raised hand: caught by', d.recoveredBy);
    expect(d.recoveredBy).toBe(d.human);
    d.destroy();
  });

  it('with the arms down the same ball goes by, and one dropped on a hanging hand bounces off', async () => {
    const d = await drill(still());
    run(d, 0.6);
    throwThrough(d, wide(d, 1, 0.3), 4, 0.3);
    run(d, 1, () => d.world.ballCarrier >= 0);
    expect(d.recoveredBy).toBe(-1);
    const h = wide(d, 1, 0.06), w = d.world; // over the hand's outer edge
    w.scene.placeProp(d.ball, [h[0], h[1] + 0.3, h[2]], [0, 0, 0, 1]);
    w.scene.launchProp(d.ball, [0, 0, 0], [0, 0, 0]);
    let hit = false; const touched = new Set<string>();
    run(d, 1, () => {
      for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) if (p.athlete < 0 && p.seg === d.ball && o.athlete === d.human) { hit = true; touched.add(w.athletes[d.human].plan.segments[o.seg].name); }
      return w.ballCarrier >= 0;
    });
    console.log('arms down: wide ball caught by', d.recoveredBy, ', dropped ball struck him', hit, [...touched]);
    expect(hit).toBe(true);
    expect(d.recoveredBy).toBe(-1);
    expect(w.ballCarrier).toBe(-1);
    d.destroy();
  });

  /** The human jogs with both arm buttons held, then (`dive`) presses dive as a low ball is thrown to come down
   *  1.5 m beyond where his run takes him in 0.5 s (about 3 m beyond his hands). Whether he catches it before it
   *  touches the turf, how high it is then, and the drill after 2 s more. */
  async function layOut(dive: boolean) {
    const human = new HumanBrain();
    human.latest = input({ move: { x: 0, y: 1 }, armL: 1, armR: 1 });
    const d = await drill(human);
    run(d, 1.6);
    const s = d.world.scene.athletes[d.human].state, w = d.world;
    if (dive) human.latest = { ...human.latest!, held: new Set(['dive']) };
    throwThrough(d, [s.com[0] + 0.3, 0.4, s.com[2] + s.comVel[2] * 0.5 + 1.5], 6, 0.5, -3);
    let turf = false, air = false;
    run(d, 1.5, () => {
      for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) if (p.athlete < 0 && p.seg === d.ball && o.athlete < 0 && o.seg < 0) turf = true;
      air ||= !w.athletes[d.human].feet.some((f) => f.touching);
      return w.ballCarrier >= 0 || turf;
    });
    const out = { caught: !turf && d.recoveredBy === d.human, y: d.ballPos()[1], air, d };
    human.latest = input();
    run(d, 2);
    return out;
  }

  it('a diving catch: a low ball beyond his reach running is caught laid out, in the air, and he is not down', async () => {
    const ran = await layOut(false), dove = await layOut(true), d = dove.d;
    console.log('low ball 1.5 m beyond the run: running caught', ran.caught, '; diving caught', dove.caught, 'at ball height', dove.y.toFixed(2), 'm, body in flight', dove.air, ', drill ended', d.ended);
    expect(ran.caught).toBe(false);
    expect(dove.caught).toBe(true);
    expect(dove.air).toBe(true);
    expect(d.ended).toBe(null);
    expect(d.world.ballCarrier).toBe(d.human);
    expect(d.world.scene.stats().instabilities).toBe(0);
    ran.d.destroy(); d.destroy();
  });
});
