// The natural moves (owner request 2026-10-23): slide, ball cover, stiff-arm, hurdle and hand plant. Each is a pose the
// muscles track (plus, for the cover, a second grip on the ball); what they do is the physics'.
import { beforeAll, describe, expect, it } from 'vitest';
import { kinematicRig } from '../src/sim/anim/rig';
import { neutralCommands, type Commands } from '../src/sim/control/types';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Perception } from '../src/sim/brains/types';
import { MODES } from '../src/sim/modes/registry';
import { Play } from '../src/sim/modes/play';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { qaxis } from '../src/sim/math';
import { CFG } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const carry = MODES.find((m) => m.id === 'carry')!;

/** The human carrier (athlete 0) on a script, for `seconds`; `each` sees the play every step. */
async function carrier(script: (t: number, p: Perception, c: Commands) => void, seconds: number, each?: (p: Play) => void) {
  const p = await Play.create(mujocoEngine, CFG, carry, {}, new ScriptBrain(script), 0);
  for (let i = 0, n = Math.round(seconds / p.world.dt); i < n && !p.ended; i++) { p.step(); each?.(p); }
  return p;
}

describe('moves (headless physics)', () => {
  it('slide: a running carrier sits down feet first and is down by rule, untouched, without a knockout', async () => {
    let touched = false, at = -1;
    const p = await carrier((t, _p, c) => {
      c.move = { x: 0, z: -1 }; c.gait = 'sprint';
      c.slide = t > 2 && t < 2.1;
    }, 4, (q) => { const a = q.world.athletes[0]; touched ||= a.touching.length > 0; if (at < 0 && a.downBy) at = q.world.time; });
    const w = p.world, a = w.athletes[0];
    for (let i = 0; i < 240; i++) p.step(); // he slides on to a stop
    console.log(`slide: down by ${a.downBy} at ${(at - 2).toFixed(2)} s after the press, rep ended '${p.ended}'`);
    expect(touched).toBe(false);
    expect(at - 2).toBeGreaterThan(0); expect(at - 2).toBeLessThan(1.2);
    expect(p.ended).toBe('down');
    expect(a.injury.ko).toBe(false);
    expect(w.scene.stats().instabilities).toBe(0);
    p.destroy();
  });

  it.each([['standing', 0], ['sprinting', -1]])('cover (%s): the free hand comes onto the ball and grips it too; off, it lets go', async (_n, z) => {
    let both = false;
    const p = await carrier((t, _p, c) => { c.cover = t < 1.6; c.move = { x: 0, z }; c.gait = 'sprint'; }, 2, (q) => {
      const a = q.world.athletes[0];
      if (q.world.time < 1.6) both ||= a.grips.every((g) => g.active && q.world.isBall(g.target));
    });
    const w = p.world, a = w.athletes[0];
    expect(both).toBe(true);
    expect(a.grips[0].active).toBe(false);                               // let go once the cover ends
    expect(a.grips[1].active && w.isBall(a.grips[1].target)).toBe(true); // the carrying hand still has it
    expect(w.scene.stats().instabilities).toBe(0);
    p.destroy();
  });

  it('stiff-arm: the raised free arm locks out straight at the aim and grabs nothing', async () => {
    const elbow = async (stiff: boolean) => {
      let e = 0;
      const p = await carrier((_t, q, c) => {
        const me = q.athletes[0];
        c.armL = 1; c.stiffArm = stiff; c.aim = [me.head[0], me.head[1] - 0.3, me.head[2] + 1.5];
      }, 1, (q) => { const a = q.world.athletes[0]; e = q.world.scene.athletes[0].state.q[a.muscles.index('elbowL.flex')]; });
      const g = p.world.athletes[0].grips[0].active;
      p.destroy();
      return { e, g };
    };
    const on = await elbow(true), off = await elbow(false);
    console.log(`left elbow: stiff-arm ${on.e.toFixed(3)} rad, reach ${off.e.toFixed(3)} rad`);
    expect(on.e).toBeLessThan(off.e);
    expect(on.e).toBeLessThan(0.15);
    expect(on.g).toBe(false);
  });

  it('hurdle: a jump with the hurdle flag tucks the trailing knee and reaches the lead leg out straight', async () => {
    const legs = async (hurdle: boolean) => {
      let hip = 0, knee = 0, trail = 0;
      const p = await carrier((t, _p, c) => { c.jump = t < 0.05; c.hurdle = hurdle; }, 1.2, (q) => {
        const a = q.world.athletes[0], s = q.world.scene.athletes[0].state, m = a.muscles;
        if (a.feet[0].touching || a.feet[1].touching) return;
        if (s.q[m.index('hipR.flex')] > hip) { hip = s.q[m.index('hipR.flex')]; knee = s.q[m.index('kneeR.flex')]; trail = s.q[m.index('kneeL.flex')]; }
      });
      p.destroy();
      return { hip, knee, trail };
    };
    const h = await legs(true), j = await legs(false);
    console.log(`in the air: hurdle lead hip ${h.hip.toFixed(2)} knee ${h.knee.toFixed(2)} trail knee ${h.trail.toFixed(2)}; jump hip ${j.hip.toFixed(2)} knee ${j.knee.toFixed(2)}`);
    expect(h.hip).toBeGreaterThan(j.hip);
    expect(h.knee).toBeLessThan(h.trail - 0.5);
  });
});

describe('hand plant (animator)', () => {
  /** The left hand's height after 0.4 s with the trunk tipped `tilt` rad forward and a knock of `knock`. */
  const hand = (plant: boolean, tilt: number, knock: number) => {
    const r = kinematicRig();
    r.lie.on = true; r.lie.height = r.plan.standHeight * 0.85; r.lie.quat = qaxis([1, 0, 0], tilt);
    r.support.posture = 1 - knock;
    for (let i = 0; i < 96; i++) { Object.assign(r.cmd, neutralCommands()); r.cmd.armL = 1; r.cmd.plant = plant; r.step([0, 0]); }
    const k = r.plan.segments.findIndex((s) => s.name === 'handL');
    return r.pose.pos[k][1];
  };
  it('a held arm reaches down for the turf while he stumbles a little, not when knocked hard or tipped past 0.8 rad', () => {
    const base = hand(false, 0.4, 0.3), on = hand(true, 0.4, 0.3);
    console.log(`hand height: reach ${base.toFixed(2)} m, plant ${on.toFixed(2)} m`);
    expect(on).toBeLessThan(base - 0.3);
    expect(hand(true, 0.4, 0.9)).toBeCloseTo(hand(false, 0.4, 0.9), 6); // a real tackle: no save
    expect(hand(true, 1.0, 0.3)).toBeCloseTo(hand(false, 1.0, 0.3), 6); // already going over
    expect(hand(true, 0.4, 0)).toBeCloseTo(hand(false, 0.4, 0), 6);     // his own lean: nothing to save
  });
});
