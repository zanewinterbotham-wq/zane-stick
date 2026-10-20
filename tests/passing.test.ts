// Passing (docs/passing.md): the throw math, a throw through the athlete landing where it was aimed, the forward pass
// rules (one pass from behind the line; incomplete on the turf; an interception is the defense's catch), the QB 1-on-1
// mode's bots (the football brains) over seeded reps 1 v 1 and 2 v 2 per coverage, and the multiplayer wire.
import { beforeAll, describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Brain } from '../src/sim/brains/types';
import type { PassCmd } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import { PASS_MODE } from '../src/sim/modes/pass';
import { Play } from '../src/sim/modes/play';
import { listSlots, resolveOptions } from '../src/sim/modes/registry';
import type { ModeOptions, PlayConfig } from '../src/sim/modes/types';
import { Rng } from '../src/sim/rng';
import { decodeInput, encodeInput, PASS_REPEAT, type PassHold } from '../src/sim/net/input';
import { encodeSnapshot, Replica } from '../src/sim/net/snapshot';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { leadPoint, THROW, throwError, throwVelocity } from '../src/sim/throw';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };
const G = 9.81;
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });
/** Where a vacuum trajectory is t s on. */
const fly = (p: Vec3, v: Vec3, t: number): Vec3 => [p[0] + v[0] * t, p[1] + v[1] * t - G * t * t / 2, p[2] + v[2] * t];

/** The QB 1-on-1 mode with options; athlete 0 a scripted brain (null: every athlete a bot). */
async function passPlay(opts: ModeOptions, human: Brain | null, rep = 0) {
  return Play.create(mujocoEngine, CFG, PASS_MODE, { ...resolveOptions(PASS_MODE), ...opts }, human, rep, human ? {} : { human: -1 });
}
/** Steps a play to its end (or `until` s), checking the solver stays stable. */
function run(play: Play, until = Infinity) {
  while (!play.ended && play.repTime < until) play.step();
  expect(play.world.scene.stats().instabilities).toBe(0);
  return play;
}
/** A quarterback who stands and throws `pass(p)` once at `at` s (rep time). */
function thrower(at: number, pass: (p: Play) => PassCmd, get: () => Play | null, move?: { x: number; z: number }): Brain {
  let sent = false;
  return new ScriptBrain((_t, _p, c) => {
    const play = get();
    if (!play || play.repTime <= 0) return;
    if (move) { c.move = move; c.gait = 'sprint'; }
    if (!sent && play.repTime >= at) { sent = true; c.pass = pass(play); }
  });
}

describe('throw math', () => {
  it('throwVelocity reaches its point: loft 0 at the arm\'s top speed, loft 1 the least-speed throw; out of range it falls short', () => {
    const from: Vec3 = [0, 1.8, 0], at: Vec3 = [3, 1.3, 20];
    for (const loft of [0, 0.5, 1]) {
      const { vel, time } = throwVelocity(from, at, loft), end = fly(from, vel, time);
      for (let k = 0; k < 3; k++) expect(end[k]).toBeCloseTo(at[k], 6);
      if (loft === 0) expect(Math.hypot(...vel)).toBeCloseTo(THROW.vmax, 6);
      if (loft === 1) { const R = Math.hypot(3, 20, -0.5); expect(Math.hypot(...vel)).toBeCloseTo(Math.sqrt(G * (R - 0.5)), 6); }
    }
    expect(throwVelocity(from, at, 1).time).toBeGreaterThan(throwVelocity(from, at, 0).time);
    // 90 m is beyond the arm: 45° at full speed, landing short
    const far = throwVelocity(from, [0, 1.3, 90], 0.3);
    expect(Math.hypot(...far.vel)).toBeCloseTo(THROW.vmax, 6);
    expect(fly(from, far.vel, far.time)[2]).toBeLessThan(80);
  });

  it('leadPoint: a receiver running on meets the ball there, the motion before the release included', () => {
    const from: Vec3 = [0, 1.9, -5], t = { pos: [-10, 1.35, 5] as Vec3, vel: [1, 0, 8] as Vec3 };
    for (const loft of [0.1, 0.6]) {
      const at = leadPoint(from, t, loft), T = THROW.release + throwVelocity(from, at, loft).time;
      expect(Math.hypot(at[0] - (t.pos[0] + t.vel[0] * T), at[2] - (t.pos[2] + t.vel[2] * T))).toBeLessThan(0.01);
      expect(at[1]).toBe(1.35);
    }
  });

  it('the miss grows with the throw\'s length, the passer\'s speed, his knock, pressure and loft', () => {
    const e = throwError(15, 0, 0, false, 0);
    expect(e).toBeGreaterThan(0);
    for (const x of [throwError(30, 0, 0, false, 0), throwError(15, 6, 0, false, 0), throwError(15, 0, 0.8, false, 0), throwError(15, 0, 0, true, 0), throwError(15, 0, 0, false, 1)]) expect(x).toBeGreaterThan(e);
  });
});

describe('a throw through the athlete', () => {
  it('a standing quarterback\'s 15 m throw goes where he aimed it, off by its recorded error', async () => {
    let play: Play | null = null;
    const aim: Vec3 = [2, 1.35, 0];
    play = await passPlay({ route: 'go' }, thrower(0.3, (p) => { aim[2] = p.ballPos()[2] + 15; return { at: [...aim], loft: 0.3 }; }, () => play));
    const w = play.world;
    // the motion: the throwing arm whips, the ball leaves the hand at THROW.release, spinning nose first
    while (!play.lastPass) { play.step(); expect(play.repTime).toBeLessThan(1.5); }
    const lp = play.lastPass, v = w.scene.propVel(play.ball);
    expect(play.pass).toBe('air');
    expect(w.ballCarrier).toBe(-1);
    expect(lp.time - play.repStart).toBeCloseTo(0.3 + THROW.release, 1);
    expect(lp.speed).toBeGreaterThan(12); expect(lp.speed).toBeLessThanOrEqual(THROW.vmax + 1e-6);
    expect(lp.error).toBeLessThan(1);
    expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(lp.speed, 0);
    // it comes down through the aimed height where the error sent it (no drag in the scene: a clean flight)
    let prev = play.ballPos(), cross: Vec3 | null = null;
    while (!play.ended && !cross) {
      play.step();
      const b = play.ballPos();
      if (b[1] < lp.to[1] && prev[1] >= lp.to[1] && w.scene.propVel(play.ball)[1] < 0) cross = b;
      prev = b;
    }
    expect(cross).not.toBeNull();
    const miss = Math.hypot(cross![0] - aim[0], cross![2] - aim[2]), off = Math.hypot(cross![0] - lp.to[0], cross![2] - lp.to[2]);
    console.log(`15 m throw: speed ${lp.speed.toFixed(1)} m/s, error ${lp.error.toFixed(2)} m, landed ${miss.toFixed(2)} m from the aim, ${off.toFixed(2)} m from where the error sent it`);
    expect(miss).toBeLessThan(1);
    expect(off).toBeLessThan(0.3);
    run(play);
    play.destroy();
  });
});

describe('forward pass rules', () => {
  it('a pass to nobody that lands is incomplete: the rep ends there, worded "Incomplete"; a second pass is ignored', async () => {
    let play: Play | null = null;
    play = await passPlay({ route: 'go' }, thrower(0.3, (p) => ({ at: [20, 1.35, p.ballPos()[2] + 12], loft: 0.4 }), () => play));
    run(play);
    expect(play.ended).toBe('incomplete');
    expect(play.pass).toBe('incomplete');
    expect(play.verdictFor(0)).toBe('Incomplete');
    expect(play.recoveredBy).toBe(-1);
    expect(play.passOk(0)).toBe(false);
    play.destroy();
  });

  it('a pass from beyond the line of scrimmage is ignored: no throw, he keeps the ball', async () => {
    let play: Play | null = null;
    // he runs upfield past the line (5 yd ahead of him), then tries to throw
    play = await passPlay({ route: 'go' }, thrower(2.5, (p) => ({ at: [0, 1.35, p.ballPos()[2] + 10], loft: 0.3 }), () => play, { x: 0, z: 1 }));
    run(play, 3.5);
    expect(play.ballPos()[2]).toBeGreaterThan(play.mode.los!);
    expect(play.lastPass).toBeNull();
    expect(play.pass).toBe('none');
    expect(play.world.ballCarrier).toBe(0);
    play.destroy();
  });

  it('caught by the defense is an interception (his to run back), never a fumble recovery', async () => {
    // thrown at the cornerback (a second player, standing with his hands up to the ball): the catch rule decides, so a
    // few reps, of which at least one is picked off
    const cb = 2, seen: string[] = [];
    const hands = () => new ScriptBrain((_t, p, c) => {
      const me = p.athletes[p.self], b = p.ball?.pos;
      c.face = { x: -Math.sign(me.com[0]) * 0.5, z: -1 };
      c.armL = c.armR = 1; c.gripL = c.gripR = true;
      c.aim = b && !p.athletes.some((a) => a.hasBall) ? [...b] as Vec3 : [me.com[0], me.head[1] - 0.3, me.com[2] - 0.6];
    });
    let picked: Play | null = null;
    for (let rep = 0; rep < 4 && !picked; rep++) {
      let play: Play | null = null;
      play = await Play.create(mujocoEngine, CFG, PASS_MODE, { ...resolveOptions(PASS_MODE), route: 'curl', coverage: 'off' }, thrower(0.9, (p) => {
        const s = p.world.scene.athletes[cb].state, from = p.world.handPoint(p.world.athletes[0], 1);
        return { at: leadPoint(from, { pos: [s.com[0], 1.4, s.com[2]], vel: [...s.comVel] as Vec3 }, 0.2), loft: 0.2 };
      }, () => play), rep, { fixed: [null, null, hands()] });
      while (!play.ended && play.pass !== 'intercepted' && play.repTime < 6) play.step();
      seen.push(play.pass);
      if (play.pass === 'intercepted') picked = play; else play.destroy();
    }
    console.log(`thrown at the corner: ${seen.join(', ')}`);
    const play = picked!;
    expect(play).not.toBeNull();
    expect(play.world.ballCarrier).toBe(cb);
    expect(play.lastCatch?.athlete).toBe(cb);
    run(play);
    expect(play.recoveredBy).toBe(-1);
    expect(play.verdictFor(0)).toMatch(/Intercepted!|Pick six against you/);
    expect(play.verdictFor(1)).toMatch(/You picked it off|Pick six!/);
    play.destroy();
  });

  it('2 v 2 with a player at QB: his pass to a fixed point flies and ends the rep; the bots are the football brains', async () => {
    let play: Play | null = null;
    play = await passPlay({ receivers: 2, coverage: 'zone' }, thrower(1.5, (p) => ({ at: [-6, 1.3, p.mode.los! + 12], loft: 0.4 }), () => play));
    expect(play.mode.players.map((s) => s.label)).toEqual(['QB', 'WR1', 'WR2', 'CB1', 'CB2']);
    expect(play.brains.slice(1).map((b) => b.constructor.name)).toEqual(['ReceiverBrain', 'ReceiverBrain', 'DefensiveBackBrain', 'DefensiveBackBrain']);
    run(play);
    expect(play.lastPass?.athlete).toBe(0);
    expect(play.lastPass!.at[2]).toBeCloseTo(play.mode.los! + 12, 5);
    expect(['complete', 'incomplete', 'intercepted']).toContain(play.pass);
    play.destroy();
  });
});

describe('QB 1-on-1 setup', () => {
  it('N v N slots for the lobby, the role option, and the play call by coverage', () => {
    const o = (x: ModeOptions) => ({ ...resolveOptions(PASS_MODE), ...x });
    const slot = (x: ModeOptions) => listSlots(PASS_MODE, o(x)).map((s) => `${s.label}:${s.team}:${s.group}`);
    expect(slot({ receivers: 3 })).toEqual(['QB:0:Offense', 'WR1:0:Offense', 'WR2:0:Offense', 'WR3:0:Offense', 'CB1:1:Defense', 'CB2:1:Defense', 'S:1:Defense']);
    expect(slot({ receivers: 2, role: 'wr' })).toEqual(['WR1:0:Offense', 'QB:0:Offense', 'WR2:0:Offense', 'CB1:1:Defense', 'CB2:1:Defense']);
    // a cornerback's side is team 0 (athlete 0); the offense attacks the other way
    expect(slot({ receivers: 2, role: 'cb' })).toEqual(['CB1:0:Defense', 'QB:1:Offense', 'WR1:1:Offense', 'WR2:1:Offense', 'CB2:0:Defense']);
    for (const receivers of [1, 2, 3]) expect(PASS_MODE.athletes(o({ receivers }))).toBe(1 + 2 * receivers);
    // wide left, wide right, the slot on WR1's side; each defender over his man (zone: the safety deep in the middle)
    const s = PASS_MODE.setup(o({ receivers: 3, coverage: 'zone' }), new Rng(3), {} as PlayConfig), x = s.players.map((p) => p.pos[0]);
    expect(Math.sign(x[1])).toBe(-Math.sign(x[2]));
    expect(Math.sign(x[3])).toBe(Math.sign(x[1]));
    expect(Math.abs(x[3])).toBeLessThan(Math.abs(x[1]));
    expect(x[6]).toBe(0);
  });
});

describe('QB 1-on-1 bots (the football brains on the mode\'s play call)', () => {
  const REPS = 6;
  /** Every athlete a bot over REPS seeds: the pass outcomes and the yards a completion gained. The bots keep the same
   *  brain objects through the throw, the catch and an interception (the football brains play after the catch). */
  async function tally(opts: ModeOptions) {
    const out = { complete: 0, incomplete: 0, intercepted: 0, none: 0, yards: 0 };
    for (let rep = 0; rep < REPS; rep++) {
      const play = await passPlay(opts, null, rep), kept = [...play.brains];
      expect(play.mode.players.length).toBe(1 + 2 * +(opts.receivers ?? 1));
      run(play);
      expect(play.brains.every((b, i) => b === kept[i])).toBe(true);
      // a caught pass is a completion or an interception, never a fumble recovery (unless he fumbles after it)
      expect(play.recoveredBy < 0 || play.fumbles > 0).toBe(true);
      expect(play.pass).not.toBe('air');
      expect(play.verdictFor(0)).not.toBe('');
      out[play.pass as keyof typeof out]++;
      if (play.pass === 'complete') out.yards += (play.ballPos()[2] - play.mode.los!) / 0.9144;
      play.destroy();
    }
    return out;
  }
  async function rates(receivers: number) {
    const all = { complete: 0, incomplete: 0, intercepted: 0, none: 0 };
    for (const coverage of ['off', 'press', 'zone']) {
      const t = await tally({ receivers, coverage });
      console.log(`${receivers} v ${receivers}, man ${coverage === 'zone' ? '-' : coverage} / zone ${coverage === 'zone' ? 'yes' : '-'}, ${REPS} reps: complete ${t.complete}, incomplete ${t.incomplete}, intercepted ${t.intercepted}, no pass ${t.none}, ${(t.yards / REPS).toFixed(1)} yd/rep`);
      for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] += t[k];
    }
    // the QB never scrambles here (no rush): the ball comes out in (nearly) every rep
    expect(all.none).toBeLessThanOrEqual(1);
    expect(all.intercepted).toBeLessThan(all.complete + all.incomplete);
    return all;
  }

  it('1 v 1: outcome rates per coverage (man off, man press, zone)', async () => { await rates(1); }, 300_000);
  it('2 v 2: outcome rates per coverage, and at least one completion', async () => {
    expect((await rates(2)).complete).toBeGreaterThanOrEqual(1);
  }, 300_000);
});

describe('the same throw for humans and bots, and over the wire', () => {
  it('HumanBrain hands a pass on once, as the Commands a bot sends', () => {
    const b = new HumanBrain(), pass: PassCmd = { at: [1, 1.3, 20], loft: 0.4 };
    const p = { time: 0, self: 0, athletes: [{ com: [0, 1, 0] as Vec3, comVel: [0, 0, 0] as Vec3, pelvis: [0, 1, 0] as Vec3, head: [0, 1.8, 0] as Vec3, heading: 0, down: false, hasBall: true, team: 0 as const }], field: { halfWidth: 24, goalZ: 45, dirZ: 1 as const } };
    b.latest = input({ pass });
    expect(b.think(p).pass).toBe(pass);
    expect(b.think(p).pass).toBeNull(); // the same frame's input, a step later
    b.latest = input({ pass: { ...pass } });
    expect(b.think(p).pass).toEqual(pass);
  });

  it('a pass survives the input codec, repeated for a lost packet, and junk is refused', () => {
    const hold: PassHold = { pass: null, until: -1 }, pass: PassCmd = { at: [-3, 1.35, 18.5], loft: 0.6 };
    const d = decodeInput(encodeInput(input({ pass }), 10, hold))!;
    expect(d.input.pass!.at[2]).toBeCloseTo(18.5, 5);
    expect(d.input.pass!.loft).toBeCloseTo(0.6, 2);
    expect(decodeInput(encodeInput(input(), 10 + PASS_REPEAT, hold))!.input.pass!.at[0]).toBeCloseTo(-3, 5);
    expect(decodeInput(encodeInput(input(), 11 + PASS_REPEAT, hold))!.input.pass).toBeNull();
    expect(decodeInput(encodeInput(input(), 12))!.input.pass).toBeNull();
    for (const at of [[NaN, 1, 1], [1e6, 1, 1], [0, -5, 0]] as Vec3[]) expect(decodeInput(encodeInput(input({ pass: { at, loft: 0.5 } }), 1))!.input.pass).toBeNull();
  });

  it('a guest\'s replica shows the pass: its state and the throw', async () => {
    let play: Play | null = null;
    play = await passPlay({ route: 'go' }, thrower(0.3, (p) => ({ at: [8, 1.35, p.ballPos()[2] + 14], loft: 0.3 }), () => play));
    const guest = await passPlay({ route: 'go' }, null), rep = new Replica(guest);
    while (!play.lastPass) play.step();
    for (let k = 0; k < 10; k++) play.step();
    rep.push(encodeSnapshot(play), 0);
    rep.render(10);
    expect(guest.pass).toBe('air');
    expect(guest.passer).toBe(0);
    expect(guest.lastPass).toMatchObject({ athlete: 0, loft: expect.closeTo(0.3, 2), speed: expect.closeTo(play.lastPass.speed, 3) });
    expect(guest.lastPass!.to[2]).toBeCloseTo(play.lastPass.to[2], 3);
    play.destroy(); guest.destroy();
  });
});
