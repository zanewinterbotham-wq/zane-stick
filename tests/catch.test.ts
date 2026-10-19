// Catching (owner decision 2026-10-18): a ball in the air within reach of a raised hand is caught (hand snap) by
// chance: very likely with both hands (the diamond), less with one, less again at the edge of reach, in contact or
// laid out; a broken arm's hand never catches, and a muff bounces off and stays loose. The same rule for every athlete;
// one over a hand that is not raised bounces off. The human's raised hands go to a ball flying at him or dropping on
// him, and a dive lays him out to one beyond his reach. Scripted, headless and deterministic (seeded).
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
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });
async function drill(human: Brain, seed = 1) { return OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, seed }, human, 0); }
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

  it('a ball passing 0.3 m wide of a raised hand is in reach: a one-hand try at its edge, a long chance', async () => {
    const d = await drill(script((_t, c) => { c.armL = c.armR = 1; c.gripL = c.gripR = true; }));
    run(d, 0.6);
    throwThrough(d, wide(d, 1, 0.3), 4, 0.3);
    run(d, 1, () => d.world.ballCarrier >= 0);
    const t = d.lastCatch!;
    console.log('0.3 m wide of a raised hand: try', t && { chance: +t.chance.toFixed(2), ...t.factors, caught: t.caught });
    expect(t.athlete).toBe(d.human);
    expect(t.factors.hands).toBe(0.55);
    expect(t.factors.centred).toBeLessThan(0.6);
    expect(t.chance).toBeLessThan(0.35);
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
    const t = d.lastCatch, out = { reached: t?.athlete === d.human, caught: !turf && d.world.ballCarrier === d.human, try: t, y: d.ballPos()[1], air, d };
    human.latest = input();
    run(d, 2);
    return out;
  }

  // the diving try is decided by chance (laid out, at the edge of his reach: a long one), so this checks he gets his
  // hands to it in the air, not that this seed's roll holds it
  it('a diving catch: a low ball beyond his reach running is reached laid out, in the air, and he is not down', async () => {
    const ran = await layOut(false), dove = await layOut(true), d = dove.d;
    console.log('low ball 1.5 m beyond the run: running reached', ran.reached, '; diving reached', dove.reached, 'chance', dove.try?.chance.toFixed(2), dove.try?.factors, 'caught', dove.caught, 'at ball height', dove.y.toFixed(2), 'm, body in flight', dove.air, ', drill ended', d.ended);
    expect(ran.reached).toBe(false);
    expect(dove.reached).toBe(true);
    expect(dove.try!.factors.air).toBeLessThan(1);
    expect(dove.air).toBe(true);
    expect(d.ended).toBe(null);
    expect(d.world.scene.stats().instabilities).toBe(0);
    ran.d.destroy(); d.destroy();
  });
});

/** One soft throw (8 m/s, the top of its arc) at a catcher standing ready, world seed `seed`: both arms raised and the
 *  ball through the middle of his hands, or the right arm only and the ball at that hand. `prep` runs first (on the
 *  drill, before he settles). The try and whether he holds the ball. */
async function trial(seed: number, arms: 'both' | 'right', prep?: (d: OpenFieldDrill) => void) {
  const d = await drill(script((_t, c) => { c.armR = 1; c.gripR = true; if (arms === 'both') { c.armL = 1; c.gripL = true; } }), seed);
  prep?.(d);
  run(d, 0.6);
  const l = hand(d, 0), r = hand(d, 1), at: Vec3 = arms === 'both' ? [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2] : r;
  throwThrough(d, at, 4, 0.5);
  run(d, 0.8, () => d.world.ballCarrier >= 0);
  const out = { try: d.lastCatch, caught: d.world.ballCarrier === d.human };
  d.destroy();
  return out;
}
async function trials(n: number, arms: 'both' | 'right', prep?: (d: OpenFieldDrill) => void) {
  const out = [];
  for (let k = 1; k <= n; k++) out.push(await trial(k, arms, prep));
  return out;
}
/** An opponent in contact with the human every step (written over the world's contact read, before the play reads it). */
function inContact(d: OpenFieldDrill) {
  const w = d.world, step = w.step.bind(w);
  w.step = () => { step(); w.athletes[d.human].touching = [d.carrier]; };
}

describe('catch chance', () => {
  it('both hands (the diamond) on a soft centred ball nearly always catch; one hand clearly less; in contact less again', async () => {
    const both = await trials(20, 'both'), one = await trials(20, 'right'), hit = await trials(12, 'both', inContact);
    const n = (xs: { caught: boolean }[]) => xs.filter((x) => x.caught).length;
    const f = (xs: typeof both) => `chance ${Math.min(...xs.map((x) => x.try!.chance)).toFixed(2)}..${Math.max(...xs.map((x) => x.try!.chance)).toFixed(2)} ${JSON.stringify(xs[0].try!.factors)}`;
    console.log(`soft centred ball: both hands ${n(both)}/20 ${f(both)}; one hand ${n(one)}/20 ${f(one)}; in contact ${n(hit)}/12 ${f(hit)}`);
    for (const x of [...both, ...one, ...hit]) expect(x.try?.caught).toBe(x.caught); // every throw was tried, and the try decided it
    expect(both.every((x) => x.try!.factors.hands === 0.95)).toBe(true);
    expect(one.every((x) => x.try!.factors.hands === 0.55)).toBe(true);
    expect(n(both)).toBeGreaterThanOrEqual(18);
    expect(n(one)).toBeLessThanOrEqual(15);
    expect(n(one)).toBeLessThan(n(both) - 3);
    expect(hit.every((x) => x.try!.factors.contact < 1)).toBe(true);
    expect(n(hit) / 12).toBeLessThan(n(both) / 20 - 0.3);
  });

  it('the hand of a broken arm never catches', async () => {
    const xs = await trials(4, 'right', (d) => { (d.world.athletes[d.human].injury.arm as boolean[])[1] = true; });
    console.log(`ball at a broken arm's hand: caught ${xs.filter((x) => x.caught).length} / 4, tries ${xs.filter((x) => x.try).length}`);
    expect(xs.every((x) => !x.caught && !x.try)).toBe(true);
  });

  it('a muffed ball bounces off him physically and stays loose, with no new try while it is in his reach', async () => {
    // the first seed (in order) whose one-hand throw is muffed
    let seed = 1, res;
    while (!(res = await trial(seed, 'right')).try || res.caught) seed++;
    const d = await drill(script((_t, c) => { c.armR = 1; c.gripR = true; }), seed), w = d.world;
    run(d, 0.6);
    throwThrough(d, hand(d, 1), 4, 0.5);
    run(d, 0.8, () => d.lastCatch !== null);
    const t = d.lastCatch!, v0 = w.scene.propVel(d.ball);
    let touched = false, loose = true;
    run(d, 0.3, () => {
      for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) if (p.athlete < 0 && p.seg === d.ball && o.athlete === d.human) touched = true;
      loose &&= w.ballCarrier === -1;
    });
    const v1 = w.scene.propVel(d.ball);
    console.log(`muff (seed ${seed}, chance ${t.chance.toFixed(2)}): struck him ${touched}, ball speed ${Math.hypot(...v0).toFixed(1)} -> ${Math.hypot(...v1).toFixed(1)} m/s, new tries ${d.lastCatch === t ? 0 : 'yes'}`);
    expect(t.caught).toBe(false);
    expect(touched).toBe(true);
    expect(loose).toBe(true);
    expect(d.lastCatch).toBe(t);
    expect(w.scene.stats().instabilities).toBe(0);
    d.destroy();
  });

  it('a ball dropping onto him: both raised hands go up to where it comes down and take it overhead', async () => {
    const human = new HumanBrain();
    human.latest = input({ armL: 1, armR: 1 });
    const d = await drill(human), w = d.world;
    run(d, 0.6);
    w.releaseGrip(d.carrier, 1);
    const s = w.scene.athletes[d.human].state, hd = w.perception(d.human).athletes[d.human].head;
    w.scene.placeProp(d.ball, [s.com[0], hd[1] + 4, s.com[2] + 0.25], [0, 0, 0, 1]); // a pop-up coming straight down on him
    w.scene.launchProp(d.ball, [0, 0, 0], [0, 0, 0]);
    d.step();
    d.brains[d.carrier] = still();
    let hy = 0;
    run(d, 1.5, () => { hy = Math.max(hand(d, 0)[1], hand(d, 1)[1]); return d.lastCatch !== null; });
    const t = d.lastCatch!;
    console.log(`dropped from ${(hd[1] + 4).toFixed(1)} m: hands up to ${hy.toFixed(2)} m at the try (head ${hd[1].toFixed(2)} m), chance ${t.chance.toFixed(2)}`, t.factors, 'caught', t.caught);
    expect(t.athlete).toBe(d.human);
    expect(hy).toBeGreaterThan(hd[1]);
    expect(t.factors.hands).toBe(0.95);
    expect(t.chance).toBeGreaterThan(0.6);
    d.destroy();
  });
});
