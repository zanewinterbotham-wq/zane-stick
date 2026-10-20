// A human's reticle throw is aimed from where he is (owner bug report 2026-10-19: running, the pass went to the spot
// the ring marked at the click, as if thrown from there): its point follows the passer through the throwing motion.
// A bot's lead point is fixed (it already counts the motion).
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import type { PassCmd } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import { Play } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { decodeInput, encodeInput } from '../src/sim/net/input';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };

/** The QB sprints sideways and throws at 1.5 s to a point 15 m upfield of him; returns how far he ran during the
 *  motion (x) and where the pass was aimed at the release. */
async function runningThrow(follow: boolean) {
  let play: Play | null = null, sent = false, click: Vec3 = [0, 0, 0];
  const brain = new ScriptBrain((_t, _p, c) => {
    if (!play || play.repTime <= 0) return;
    c.move = { x: 1, z: 0 }; c.gait = 'sprint';
    if (!sent && play.repTime >= 1.5) {
      const com = play.world.scene.athletes[0].state.com;
      sent = true; click = [com[0], com[1], com[2]];
      c.pass = { at: [com[0], 1.3, com[2] + 15 * (play.world.setup.field?.dirZ ?? 1)], loft: 0.3, ...(follow && { follow: true }) } satisfies PassCmd;
    }
  });
  const def = modeById('pass');
  play = await Play.create(mujocoEngine, CFG, def, resolveOptions(def), brain, 0);
  const w = play.world;
  let ran = 0;
  while (!w.lastPass && play.repTime < 3) { play.step(); ran = w.scene.athletes[0].state.com[0] - click[0]; }
  const out = { ran, at: w.lastPass!.at, click };
  play.destroy();
  return out;
}

describe('a running throw', () => {
  it('a follow pass is aimed from where he released it; a fixed one where it was set', async () => {
    const f = await runningThrow(true), fixed = await runningThrow(false);
    console.log(`ran ${f.ran.toFixed(2)} m during the motion; follow aim x ${(f.at[0] - f.click[0]).toFixed(2)}, fixed ${(fixed.at[0] - fixed.click[0]).toFixed(2)}`);
    expect(Math.abs(f.ran)).toBeGreaterThan(2);                       // he really ran on through the motion
    expect(f.at[0] - f.click[0]).toBeCloseTo(f.ran, 1);                // the point moved with him
    expect(fixed.at[0] - fixed.click[0]).toBeCloseTo(0, 6);            // a bot's point stays put
  }, 120_000);
  it('the follow flag crosses the wire', () => {
    const i = { move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set<string>(), cameraYaw: 0, aimPitch: 0 };
    for (const follow of [true, false]) {
      const d = decodeInput(encodeInput({ ...i, pass: { at: [1, 1.3, 20], loft: 0.5, ...(follow && { follow }) } }, 1))!;
      expect(!!d.input.pass?.follow).toBe(follow);
    }
  });
});

describe('throwing in every mode (NFL)', () => {
  /** Ball Carrier (no line of scrimmage): the human carrier throws at 1 s toward a point `dz` m along his attack. */
  async function carrierThrow(dz: number) {
    let play: Play | null = null, sent = false;
    const brain = new ScriptBrain((_t, _p, c) => {
      if (!play || play.repTime < 1 || sent) return;
      const b = play.ballPos(), dir = play.world.setup.field?.dirZ ?? 1;
      sent = true; c.pass = { at: [b[0] + 3, 1.3, b[2] + dz * dir], loft: 0.4 };
    });
    const def = modeById('carry');
    play = await Play.create(mujocoEngine, CFG, def, resolveOptions(def), brain, 0);
    while (!play.world.lastPass && play.repTime < 3) play.step();
    const thrown = !!play.world.lastPass;
    for (let k = 0; k < 480 && !play.ended; k++) play.step();
    const out = { thrown, ended: play.ended, pass: play.pass, recoveredBy: play.recoveredBy, instab: play.world.scene.stats().instabilities };
    play.destroy();
    return out;
  }
  it('a forward pass is allowed without a line of scrimmage; on the turf it is incomplete', async () => {
    const r = await carrierThrow(12);
    expect([r.thrown, r.ended, r.pass, r.instab]).toEqual([true, 'incomplete', 'incomplete', 0]);
  }, 60_000);
  it('a lateral (thrown back) is a live ball: no incompletion, and no fumble recovered', async () => {
    const r = await carrierThrow(-6);
    expect(r.thrown).toBe(true);
    expect(r.ended).not.toBe('incomplete');
    expect(r.pass).toBe('none');
    expect(r.recoveredBy).toBe(-1);
    expect(r.instab).toBe(0);
  }, 60_000);
});

