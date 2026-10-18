// Open-field rep rules: the rep ends only on the ball carrier going down or scoring; a loose ball is live and is
// recovered by the trunk (a dive) or by a raised hand (a pickup). Scripted, headless and deterministic.
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL } from '../src/sim/anatomy/equipment';
import { CarrierBrain } from '../src/sim/brains/carrier';
import { HumanBrain } from '../src/sim/brains/human';
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
    // out past the sideline, then he stops: the padded wall further out (BARRIER) is not what this test is about
    d.brains[d.carrier] = script((_t, c) => { const out = d.world.scene.athletes[d.carrier].state.com[0] > 26.5; c.move = { x: out ? 0 : 1, z: 0 }; c.gait = out ? 'walk' : 'sprint'; c.carry = 2; });
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
  it('a loose ball touched by a raised hand is picked up, gripped and tucked', async () => {
    const d = await drill(script((_t, c) => { c.armR = 1; c.gripR = true; }));
    strip(d, still(), () => ballAhead(d, d.carrier, -3));
    run(d, 0.6); // the arm comes up
    const w = d.world, a = w.athletes[d.human], s = w.scene.athletes[d.human].state, h = a.handSegs[1];
    const hand: Vec3 = [s.segPos[3 * h], s.segPos[3 * h + 1], s.segPos[3 * h + 2]];
    w.scene.placeProp(d.ball, [hand[0], hand[1] + 0.12, hand[2]], [0, 0, 0, 1]);
    const touched = new Set<string>();
    run(d, 1, () => { for (const n of ballTouches(d, d.human)) touched.add(n); return w.ballCarrier >= 0; });
    console.log('hand pickup: human segments that touched the ball', [...touched]);
    expect([...touched].some((n) => /pelvis|lumbar|thorax|trunk/.test(n))).toBe(false);
    expect(d.recoveredBy).toBe(d.human);
    expect(w.ballCarrier).toBe(d.human);
    expect(w.gripping(d.human, ball(d))).toBe(1);
    expect(d.ended).toBe(null);
    d.destroy();
  });

  it('a walking human with the arms on auto picks up a ball in his path without diving', async () => {
    const human = new HumanBrain();
    human.latest = { move: { x: 0, y: 0.5 }, torso: 0, sprint: 0, sink: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0 };
    let dived = false;
    const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD }, { think: (p) => { const c = human.think(p); dived ||= c.dive; return c; } }, 0);
    d.brains[d.carrier] = still();
    d.world.releaseGrip(d.carrier, 1);
    ballAhead(d, d.human, 3);
    // the ball is in the human's path and far from the bot (who stands still, 10 m on)
    const t0 = d.world.time;
    run(d, 8, () => d.world.ballCarrier >= 0);
    console.log('walk-over pickup: recovered by', d.recoveredBy, 'after', (d.world.time - t0).toFixed(2), 's, dived', dived);
    expect(d.recoveredBy).toBe(d.human);
    expect(dived).toBe(false);
    expect(d.world.scene.stats().instabilities).toBe(0);
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

/** Bot jogs 1.2 s, then loses the ball: it is put `off` (x, z) m from him, at rest. Returns the time to his
 *  recovery (s; Infinity when he has not after 7 s), how far he ran (m) and the straight line to the ball (m). */
async function botChases(off: [number, number], rep = 0) {
  const d = await drill(still(), rep);
  run(d, 1.2);
  const w = d.world, s = w.scene.athletes[d.carrier].state, from: Vec3 = [s.com[0], 0, s.com[2]];
  w.releaseGrip(d.carrier, 1);
  w.scene.placeProp(d.ball, [from[0] + off[0], BALL.diameter / 2 + 0.01, from[2] + off[1]], [0, 0, 0, 1]);
  d.step();
  const t0 = d.repTime;
  let path = 0, last = from, top = 0, dives = 0;
  run(d, 7, () => {
    path += Math.hypot(s.com[0] - last[0], s.com[2] - last[2]); last = [s.com[0], 0, s.com[2]];
    top = Math.max(top, Math.hypot(s.comVel[0], s.comVel[2]));
    if (w.athletes[d.carrier].cmd.dive) dives++;
    return d.recoveredBy === d.carrier;
  });
  const out = { time: d.recoveredBy === d.carrier ? d.repTime - t0 : Infinity, path, line: Math.hypot(off[0], off[1]), top, dives, bad: w.scene.stats().instabilities };
  d.destroy();
  return out;
}

describe('bot chasing a loose ball', () => {
  const CASES: [number, number][] = [[0, 3], [0, -4], [4, 0], [-3, -3], [2, 7]];
  it('goes straight to it and picks it up by hand, without diving', async () => {
    for (const off of CASES) {
      const r = await botChases(off);
      console.log('loose ball', off.join(','), ': recovered in', r.time.toFixed(2), 's, ran', r.path.toFixed(1), 'm for a', r.line.toFixed(1), 'm line (', (r.path / r.line).toFixed(2), 'x ), top speed', r.top.toFixed(1), ', dive commands', r.dives);
      expect(r.time).toBeLessThan(5);
      expect(r.path / r.line).toBeLessThan(2);
      if (r.line < 5) expect(r.dives).toBe(0); // a sprint at a ball it cannot stop short of may still dive
      expect(r.bad).toBe(0);
    }
  }, 120000);
});
