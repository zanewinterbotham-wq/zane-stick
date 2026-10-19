// Headless pass scenarios for the receiver brain: a QB standing with the ball (athlete 0, scripted), receivers on
// route assignments (ReceiverBrain) and defenders given scripted brains, under the shared play rules (the catch rule).
import { ballAt, ReceiverBrain } from '../../src/sim/brains/football/receiver';
import type { Assignment, PlayCall, PlayFrame, RouteAssign } from '../../src/sim/brains/football/types';
import { ScriptBrain } from '../../src/sim/brains/script';
import type { Brain } from '../../src/sim/brains/types';
import type { Commands } from '../../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../../src/sim/drills/openField';
import type { Vec3 } from '../../src/sim/math';
import { Play } from '../../src/sim/modes/play';
import { HALF_WIDTH, NFL } from '../../src/sim/modes/rules';
import type { ModeDef, PlayerSpec } from '../../src/sim/modes/types';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import type { Rng } from '../../src/sim/rng';
import { STD } from './scenario';

const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
export const CFG = { ...base, physics: STD, bot: carrier };
export const LOS = -20;
export const FRAME: PlayFrame = { los: LOS, dir: 1, halfWidth: HALF_WIDTH, snapTime: 0 };

export interface Spec { team: 0 | 1; pos: [number, number]; assign?: Assignment; brain?: Brain }

/** A play: the QB (athlete 0, standing with the ball 7 m behind the line), then `specs` in order (index = k + 1).
 *  Receivers (a route assignment and no brain) get a ReceiverBrain kept for the whole play. */
export async function passPlay(specs: Spec[], seed = 1) {
  const call: PlayCall = { frame: FRAME, offense: 0, assign: [{ kind: 'pass', drop: 0, reads: [], scramble: false }, ...specs.map((s) => s.assign ?? null)] };
  const kept = new Map<number, Brain>();
  const players: PlayerSpec[] = [{ team: 0, label: 'QB', pos: [0, LOS - 7] }, ...specs.map((s, k) => ({ team: s.team, label: `P${k + 1}`, pos: s.pos }))];
  const brain = (_p: Play, i: number, rng: Rng): Brain | null => {
    if (i === 0) return null;
    if (!kept.has(i)) kept.set(i, specs[i - 1].brain ?? new ReceiverBrain(rng, CFG.difficulty, call, i));
    return kept.get(i)!;
  };
  const def: ModeDef = {
    id: 'test-pass', title: 'test', pitch: '', preview: '', options: [], athletes: () => players.length,
    setup: () => ({ players, ball: { holder: 0 }, rules: { ...NFL, timeLimit: 30 }, brain }),
  };
  const play = await Play.create(mujocoEngine, { ...CFG, seed }, def, {}, new ScriptBrain(() => {}), 0);
  return { play, call, receiver: (i: number) => kept.get(i) as ReceiverBrain };
}

/** Throw now from 2 m above the QB so the ball comes to `at` in T s (no drag in the model; the ball's own is small
 *  over this range). */
export function launch(play: Play, at: Vec3, T: number) {
  const w = play.world, q = w.scene.athletes[0].state.com, from: Vec3 = [q[0], 2, q[2] + 0.5];
  play.ballLoose(0, false);
  const vel: Vec3 = [(at[0] - from[0]) / T, (at[1] - from[1] + 9.81 * T * T / 2) / T, (at[2] - from[2]) / T];
  w.scene.placeProp(play.ball, from, [0, 0, 0, 1]);
  w.scene.launchProp(play.ball, vel, [0, 0, 0]);
  return { from, vel };
}

/** Where a receiver running on at his velocity meets a ball thrown at `speed` m/s (flat distance / speed), at catch
 *  height `h`: the lead, iterated. */
export function lead(play: Play, i: number, speed = 18, h = 1.3): { at: Vec3; T: number } {
  const s = play.world.scene.athletes[i].state, q = play.world.scene.athletes[0].state.com;
  let at: Vec3 = [s.com[0], h, s.com[2]], T = 0.5;
  for (let k = 0; k < 6; k++) {
    T = Math.max(0.4, Math.hypot(at[0] - q[0], at[2] - q[2]) / speed);
    at = [s.com[0] + s.comVel[0] * T, h, s.com[2] + s.comVel[2] * T];
  }
  return { at, T };
}

/** A scripted man defender on athlete `target`: off `cushion` m deep and `inside` m to the inside (toward x = 0),
 *  seeing him `lag` s late (positions extrapolated), running at most `vmax` m/s. */
export function manDefender(target: number, o: { cushion?: number; inside?: number; lag?: number; vmax?: number } = {}) {
  const { cushion = 4, inside = 1, lag = 0.3, vmax = 9 } = o;
  const seen: { t: number; com: Vec3; vel: Vec3 }[] = [];
  return new ScriptBrain((t, p, c: Commands) => {
    const r = p.athletes[target];
    seen.push({ t, com: [...r.com] as Vec3, vel: [...r.comVel] as Vec3 });
    while (seen.length > 1 && t - seen[1].t >= lag) seen.shift();
    const s = seen[0], me = p.athletes[p.self], age = t - s.t;
    const gx = s.com[0] + s.vel[0] * age - Math.sign(s.com[0]) * inside, gz = s.com[2] + s.vel[2] * age + cushion * (s.com[2] > LOS + 1 ? 0.5 : 1);
    let dx = gx - me.com[0], dz = gz - me.com[2];
    // he covers, he does not tackle: never on through the receiver (keeps 1.8 m off him, the ball is what he plays)
    const rx = me.com[0] - r.com[0], rz = me.com[2] - r.com[2], rd = Math.hypot(rx, rz) || 1e-6;
    if (rd < 1.8) { dx += rx / rd * (1.8 - rd) * 4; dz += rz / rd * (1.8 - rd) * 4; }
    const d = Math.hypot(dx, dz) || 1e-6, v = Math.min(vmax, 1.5 * d + Math.hypot(s.vel[0], s.vel[2]));
    c.move = { x: dx / d * v / 10.5, z: dz / d * v / 10.5 };
    c.gait = 'sprint';
    c.face = { x: 0, z: -1 };
  });
}

export const route = (r: RouteAssign['route'], extra: Partial<RouteAssign> = {}): RouteAssign => ({ kind: 'route', route: r, ...extra });
export { ballAt };
