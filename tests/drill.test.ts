// Open-field rep rules: the rep ends only on the ball carrier going down or scoring; a loose ball is live and is
// recovered by the trunk, never by a hand. Scripted, headless and deterministic.
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL } from '../src/sim/anatomy/equipment';
import { CarrierBrain } from '../src/sim/brains/carrier';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Commands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD, GOAL_LINE, OpenFieldDrill } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

type Script = (t: number, c: Commands) => void;
const script = (fn: Script) => new ScriptBrain((t, _p, c) => fn(t, c));
const still = () => script(() => {});
/** Dive along z (one press), from `at` seconds of world time. */
const diveAt = (at: () => number, z: 1 | -1): Script => (t, c) => { if (t >= at()) { c.move = { x: 0, z }; c.gait = 'jog'; c.dive = t < at() + 0.1; } };

async function drill(human: ScriptBrain, rep = 0) { return OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD }, human, rep); }
const ball = (d: OpenFieldDrill) => ({ athlete: -1, seg: d.ball });
/** The bot's hand opens and the ball is moved (`place`; else his hand grips it again): it is loose and the drill
 *  makes him a tackler; then he is held to `bot`. */
function strip(d: OpenFieldDrill, bot: ScriptBrain, place: () => void) {
  d.world.releaseGrip(d.carrier, 1);
  place();
  d.step();
  expect(d.fumbles).toBe(1);
  expect(d.world.ballCarrier).toBe(-1);
  d.brains[d.carrier] = bot;
}
/** Ball on the turf, long axis along z, `ahead` m in front of athlete i along z. */
function ballAhead(d: OpenFieldDrill, i: number, ahead: number) {
  const c = d.world.scene.athletes[i].state.com;
  d.world.scene.placeProp(d.ball, [c[0], BALL.diameter / 2 + 0.01, c[2] + ahead], [0, 0, 0, 1]);
}
function run(d: OpenFieldDrill, seconds: number, each?: () => boolean | void) {
  const end = d.repTime + seconds;
  while (d.repTime < end && !d.ended) { d.step(); if (each?.()) break; }
}
/** Ball contacts this step by the segment names of athlete i. */
function ballTouches(d: OpenFieldDrill, i: number): string[] {
  const w = d.world, out: string[] = [];
  for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) if (p.athlete < 0 && p.seg === d.ball && o.athlete === i) out.push(w.athletes[i].plan.segments[o.seg].name);
  return out;
}
/** Human dives on a ball placed 2.25 m ahead (a dive covers about 2 m), the bot standing still; returns once he
 *  has it (or after 3 s). From then on the human runs `after` (from his recovery time) and the bot is the drill's. */
async function humanRecovers(after: Script = () => {}) {
  let t0 = Infinity, t1 = Infinity;
  const dive = diveAt(() => t0, 1);
  const d = await drill(script((t, c) => (t < t1 ? dive(t, c) : after(t - t1, c))));
  strip(d, still(), () => ballAhead(d, d.human, 2.25));
  t0 = d.world.time;
  run(d, 3, () => d.world.ballCarrier >= 0);
  t1 = d.world.time;
  return d;
}

describe('open-field rep end', () => {
  it('ends when the carrier goes down with the ball', async () => {
    let t0 = Infinity;
    const d = await drill(still());
    d.brains[d.carrier] = script(diveAt(() => t0, -1));
    t0 = d.world.time + 0.3;
    run(d, 4);
    console.log('carrier dive: ended', d.ended, 'at', d.repTime.toFixed(2), 's, fumbles', d.fumbles);
    expect(d.ended).toBe('down');
    expect(d.world.ballCarrier).toBe(d.carrier);
    expect(d.world.scene.stats().instabilities).toBe(0);
    d.destroy();
  });

  it('running out of bounds no longer ends it, nor does the old 10 s limit', async () => {
    const d = await drill(still());
    d.brains[d.carrier] = script((_t, c) => { c.move = { x: 1, z: 0 }; c.gait = 'sprint'; c.carry = 2; });
    let out = 0;
    run(d, 12, () => { out = Math.max(out, Math.abs(d.world.scene.athletes[d.carrier].state.com[0])); });
    console.log('sideline run: furthest |x|', out.toFixed(1), 'm, ended', d.ended, 'at', d.repTime.toFixed(1), 's');
    expect(out).toBeGreaterThan((160 / 3) * 0.9144 / 2 + 2);
    expect(d.ended).toBe(null);
    expect(d.world.ballCarrier).toBe(d.carrier);
    d.destroy();
  });
});

describe('fumble recovery', () => {
  it('a loose ball touched by a hand is not recovered', async () => {
    const d = await drill(script((_t, c) => { c.armR = 1; c.gripR = true; }));
    strip(d, still(), () => ballAhead(d, d.carrier, -3));
    run(d, 0.6); // the arm comes up
    const w = d.world, a = w.athletes[d.human], s = w.scene.athletes[d.human].state, h = a.handSegs[1];
    const hand: Vec3 = [s.segPos[3 * h], s.segPos[3 * h + 1], s.segPos[3 * h + 2]];
    w.scene.placeProp(d.ball, [hand[0], hand[1] + 0.12, hand[2]], [0, 0, 0, 1]);
    const touched = new Set<string>();
    run(d, 1, () => { for (const n of ballTouches(d, d.human)) touched.add(n); });
    console.log('hand test: human segments that touched the ball', [...touched]);
    expect([...touched].some((n) => /hand|forearm/.test(n))).toBe(true);
    expect([...touched].some((n) => /pelvis|lumbar|thorax|trunk/.test(n))).toBe(false);
    expect(w.ballCarrier).toBe(-1);
    expect(w.gripping(d.human, ball(d))).toBe(-1);
    expect(d.ended).toBe(null);
    d.destroy();
  });

  it('diving on it recovers it with the trunk, deterministically, and the human then attacks the far end zone', async () => {
    const d = await humanRecovers(), b = await humanRecovers(), w = d.world;
    console.log('human dive: recovered at', d.repTime.toFixed(3), 's, by', d.recoveredBy, 'holding in hand', w.gripping(d.human, ball(d)));
    expect(d.recoveredBy).toBe(d.human);
    expect(w.ballCarrier).toBe(d.human);
    expect(w.gripping(d.human, ball(d))).toBe(1);
    expect(w.perception(d.carrier).field.dirZ).toBe(1);
    expect(b.repTime).toBe(d.repTime);
    expect([...b.world.scene.propPose(b.ball).pos]).toEqual([...w.scene.propPose(d.ball).pos]);
    // lying on the turf with it is not down: nobody has touched him
    d.brains[d.carrier] = still();
    run(d, 1.5);
    expect(d.ended).toBe(null);
    expect(w.scene.stats().instabilities).toBe(0);
    d.destroy(); b.destroy();
  });

  it('after recovering, the rep ends on his touchdown', async () => {
    // get up, then sprint for the far end zone, around the bot (who stays out of the way)
    const d = await humanRecovers((t, c) => { if (t > 2) { c.move = { x: 0.3, z: 1 }; c.gait = 'sprint'; } });
    expect(d.world.ballCarrier).toBe(d.human);
    d.brains[d.carrier] = still();
    run(d, 14);
    const z = d.world.scene.athletes[d.human].state.com[2];
    console.log('human run: ended', d.ended, 'at', d.repTime.toFixed(1), 's, z', z.toFixed(1));
    expect(d.ended).toBe('touchdown');
    expect(z).toBeGreaterThan(GOAL_LINE);
    expect(d.world.ballCarrier).toBe(d.human);
    d.destroy();
  });

  it('after recovering, the rep ends when the bot tackles him', async () => {
    // the drill made the bot a tackler at the recovery; the human gets up and runs at him
    const d = await humanRecovers((t, c) => { if (t > 1.5) { c.move = { x: 0, z: 1 }; c.gait = 'jog'; } });
    let touched = false;
    run(d, 12, () => { touched ||= d.world.athletes[d.human].playerContact; });
    console.log('tackle after recovery: ended', d.ended, 'at', d.repTime.toFixed(1), 's, carrier', d.world.ballCarrier, 'fumbles', d.fumbles);
    expect(d.ended).toBe('down');
    expect(d.world.ballCarrier).toBe(d.human);
    expect(touched).toBe(true);
    d.destroy();
  });

  it('the bot recovers a ball it falls on, and runs for the human goal line again', async () => {
    let t0 = Infinity;
    const d = await drill(still());
    strip(d, script(diveAt(() => t0, -1)), () => ballAhead(d, d.carrier, -2.25));
    t0 = d.world.time;
    run(d, 3, () => d.world.ballCarrier >= 0);
    console.log('bot dive: recovered by', d.recoveredBy, 'at', d.repTime.toFixed(2), 's');
    expect(d.recoveredBy).toBe(d.carrier);
    expect(d.world.ballCarrier).toBe(d.carrier);
    expect(d.brains[d.carrier]).toBeInstanceOf(CarrierBrain);
    expect(d.world.perception(d.human).field.dirZ).toBe(-1);
    d.destroy();
  });
});
