// Bot QB headless (src/sim/brains/football/qb.ts): simulated athletes, scripted receivers and defenders, the bot QB's
// Commands.pass recorded (the World's throw is the mode agent's: the ball is not required to fly). Checks the target,
// the timing on the progression's clock, and the lead point against where the receiver really is when the ball would
// arrive; 1 v 1 and 2 v 2 (nothing assumes one receiver or one defender), a blitz (the hot route), all covered (thrown
// away, or a scramble). Physics stays stable throughout.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { DIFFICULTY } from '../src/sim/brains/carrier';
import { QBBrain } from '../src/sim/brains/football/qb';
import type { PassAssign, PlayCall } from '../src/sim/brains/football/types';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Brain } from '../src/sim/brains/types';
import { TrackingController } from '../src/sim/control/tracking';
import type { Vec3 } from '../src/sim/math';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { World } from '../src/sim/world';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const SNAP = 0.3, HW = 24.38, V = 10.5;
const frame = { los: 0, dir: 1 as const, halfWidth: HW, snapTime: SNAP };
/** A receiver's route: from the snap, up the field to `stem` m (drifting to his start x), then along `brk`. */
const route = (x0: number, stem: number, brk: [number, number], speed = 0.8) => new ScriptBrain((t, p, c) => {
  if (t < SNAP) return;
  const me = p.athletes[p.self];
  c.gait = 'sprint';
  const [x, z] = me.com[2] < stem ? [0.15 * (x0 - me.com[0]), 1] : brk, n = Math.hypot(x, z);
  c.move = { x: x / n * speed, z: z / n * speed };
});
/** A man defender keeping `off` from receiver `target` (his velocity plus a pull to the spot). */
const shadow = (target: number, off: Vec3) => new ScriptBrain((t, p, c) => {
  if (t < SNAP) return;
  const me = p.athletes[p.self], r = p.athletes[target];
  const vx = r.comVel[0] + 2 * (r.com[0] + off[0] - me.com[0]), vz = r.comVel[2] + 2 * (r.com[2] + off[2] - me.com[2]), n = Math.hypot(vx, vz);
  c.gait = 'sprint';
  if (n > 0.2) { const m = Math.min(1, n / V); c.move = { x: vx / n * m, z: vz / n * m }; }
});
/** A blitzer sprinting at athlete `at` from the snap. */
const blitz = (at: number) => new ScriptBrain((t, p, c) => {
  if (t < SNAP) return;
  const me = p.athletes[p.self], q = p.athletes[at], dx = q.com[0] - me.com[0], dz = q.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1;
  c.gait = 'sprint'; c.move = { x: dx / d, z: dz / d };
});
const still = () => new ScriptBrain(() => {});

interface Who { pos: Vec3; team: 0 | 1; brain: Brain; yaw?: number; hasBall?: boolean }
async function play(pass: PassAssign, others: Who[], seconds: number, seed = 1) {
  const call: PlayCall = { frame, offense: 0, assign: [pass, ...others.map(() => null)] };
  const qb = new QBBrain(new Rng(seed), DIFFICULTY.normal, call, 0);
  let commands = 0;
  const rec: Brain = { think: (p, dt) => { const c = qb.think(p, dt); if (c.pass) commands++; return c; } };
  const w = await World.create(mujocoEngine, {
    physics: STD, seed, assist: 0, support: { ...DEFAULT_SUPPORT }, field: { halfWidth: HW, goalZ: 50, dirZ: 1 },
    athletes: [{ pos: [0, 0, -1], team: 0, brain: rec, hasBall: true } as Who, ...others].map((a) => ({
      params: DEFAULT_ATHLETE, pos: a.pos, yaw: a.yaw ?? (a.team ? Math.PI : 0), team: a.team, hasBall: a.hasBall,
      controller: (pl, m) => new TrackingController(pl, m), brain: a.brain,
    })),
  });
  // receiver positions over time, to compare the lead point with where he is when the ball would arrive
  const track: { t: number; pos: Vec3[]; vel: Vec3[] }[] = [];
  let maxQbDepth = -Infinity;
  while (w.time < seconds || (qb.lastPass && w.time < qb.lastPass.t + qb.lastPass.time + 0.05)) {
    w.step();
    track.push({ t: w.time, pos: w.athletes.map((_, i) => [...w.scene.athletes[i].state.com] as Vec3), vel: w.athletes.map((_, i) => [...w.scene.athletes[i].state.comVel] as Vec3) });
    maxQbDepth = Math.max(maxQbDepth, w.scene.athletes[0].state.com[2]);
  }
  const lp = qb.lastPass;
  let miss = NaN, along = NaN, v0 = NaN, v1 = NaN;
  if (lp && lp.target >= 0) {
    const arrive = lp.t + lp.time, s = track.find((x) => x.t >= arrive) ?? track[track.length - 1], s0 = track.find((x) => x.t >= lp.t)!;
    const ex = s.pos[lp.target][0] - lp.cmd.at[0], ez = s.pos[lp.target][2] - lp.cmd.at[2], u = s.vel[lp.target], un = Math.hypot(u[0], u[2]) || 1;
    miss = Math.hypot(ex, ez); along = (ex * u[0] + ez * u[2]) / un;
    v0 = Math.hypot(s0.vel[lp.target][0], s0.vel[lp.target][2]); v1 = un;
  }
  const inst = w.scene.stats().instabilities;
  w.destroy();
  return { qb, lp, commands, miss, along, v0, v1, inst, maxQbDepth };
}
const fmt = (r: Awaited<ReturnType<typeof play>>) => r.lp
  ? `to ${r.lp.target} (read ${r.lp.read}, ${r.lp.kind}, loft ${r.lp.loft}) at ${(r.lp.t - SNAP).toFixed(2)} s after the snap, open ${r.lp.open.toFixed(2)}, flight ${r.lp.time.toFixed(2)} s, at [${r.lp.cmd.at.map((v) => v.toFixed(1)).join(', ')}], receiver ${r.miss.toFixed(2)} m from it on arrival (${r.along.toFixed(2)} m past it along his run; his speed ${r.v0.toFixed(1)} → ${r.v1.toFixed(1)} m/s)`
  : `no pass (phase ${r.qb.phase})`;

// parked: QBBrain is being retuned for the real throw.ts (branch ai-integrate-brains); it is not in the game yet
describe.skip('bot QB headless', () => {
  it('1 v 1: an open receiver on a go route is hit in stride after the drop', async () => {
    const r = await play({ kind: 'pass', drop: 5, reads: [{ target: 1, by: 2.5 }], scramble: false },
      [{ pos: [8, 0, 0], team: 0, brain: route(8, 99, [0, 1]) }, { pos: [20, 0, 25], team: 1, brain: still() }], 3.5);
    console.log('1v1 open go:', fmt(r), 'instabilities', r.inst);
    expect(r.lp?.target).toBe(1);
    expect(r.commands).toBe(1);
    expect(r.lp!.t - SNAP).toBeGreaterThan(1);   // after the drop and the set
    expect(r.lp!.t - SNAP).toBeLessThan(2.5);
    expect(r.miss).toBeLessThan(1.5);
    expect(r.inst).toBe(0);
  });

  it('2 v 2: the first read is manned up, the second is open: the QB moves on and leads him', async () => {
    const r = await play({ kind: 'pass', drop: 5, reads: [{ target: 1, by: 2 }, { target: 2, by: 3 }], scramble: false }, [
      { pos: [8, 0, 0], team: 0, brain: route(8, 99, [0, 1]) },
      { pos: [-8, 0, 0], team: 0, brain: route(-8, 2, [0.35, 1]) },    // a seam angling in
      { pos: [8.5, 0, -0.8], team: 1, yaw: 0, brain: shadow(1, [0.5, 0, -0.8]) },
      { pos: [-18, 0, 22], team: 1, brain: still() },
    ], 4);
    console.log('2v2 first read covered:', fmt(r), 'instabilities', r.inst);
    expect(r.lp?.target).toBe(2);
    expect(r.lp!.read).toBe(1);
    expect(r.commands).toBe(1);
    expect(r.miss).toBeLessThan(2);
    expect(r.inst).toBe(0);
  });

  it('a blitz off the edge: the hot route goes out early', async () => {
    const r = await play({ kind: 'pass', drop: 5, reads: [{ target: 1, by: 2 }], hot: 2, scramble: false }, [
      { pos: [8, 0, 0], team: 0, brain: route(8, 99, [0, 1]) },
      { pos: [-6, 0, 0], team: 0, brain: route(-6, 2, [0.8, 1]) },     // a quick slant
      { pos: [8.5, 0, -0.8], team: 1, yaw: 0, brain: shadow(1, [0.5, 0, -0.8]) },
      { pos: [4, 0, 1.5], team: 1, brain: blitz(0) },
    ], 2.5);
    console.log('blitz:', fmt(r), 'instabilities', r.inst);
    expect(r.lp?.target).toBe(2);
    expect(r.lp!.read).toBe(-1);
    expect(r.lp!.t - SNAP).toBeLessThan(1.2);
    expect(r.inst).toBe(0);
  });

  it('2 v 2 all manned up: no covered man is thrown to; late, it is thrown away (or, allowed to, he runs)', async () => {
    const who = (): Who[] => [
      { pos: [8, 0, 0], team: 0, brain: route(8, 99, [0, 1]) },
      { pos: [-8, 0, 0], team: 0, brain: route(-8, 99, [0, 1]) },
      // men on top (half a step deeper, inside): no lead throw and no back-shoulder ball beats them
      { pos: [7.5, 0, 0.8], team: 1, yaw: 0, brain: shadow(1, [-0.5, 0, 0.8]) },
      { pos: [-7.5, 0, 0.8], team: 1, yaw: 0, brain: shadow(2, [0.5, 0, 0.8]) },
    ];
    const reads = [{ target: 1, by: 1.8 }, { target: 2, by: 2.6 }];
    const r = await play({ kind: 'pass', drop: 5, reads, scramble: false }, who(), 4.5);
    console.log('all covered, no scramble:', fmt(r), 'instabilities', r.inst);
    expect(r.lp?.target).toBe(-1);
    expect(Math.abs(r.lp!.cmd.at[0])).toBeGreaterThan(HW);
    expect(r.lp!.t - SNAP).toBeGreaterThan(2.6 + 1);
    expect(r.inst).toBe(0);
    const s = await play({ kind: 'pass', drop: 5, reads, scramble: true }, who(), 5);
    console.log('all covered, scramble allowed: phase', s.qb.phase, 'furthest QB z', s.maxQbDepth.toFixed(1), 'm (LOS 0)', 'instabilities', s.inst);
    expect(s.lp).toBe(null);
    expect(s.qb.phase).toBe('scramble');
    expect(s.maxQbDepth).toBeGreaterThan(1);
    expect(s.inst).toBe(0);
  });
});
