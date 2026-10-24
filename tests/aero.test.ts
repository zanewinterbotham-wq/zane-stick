// The ball's air loads (physics/aero.ts): drag by orientation, a spiral's nose following its flight, and the aim that
// gets a pass or kick where it was meant to go through the air.
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL, BALL_AERO, BALL_TURF } from '../src/sim/anatomy/equipment';
import { qaxis, qrot, type Vec3 } from '../src/sim/math';
import { aimThroughAir, ballAir, flyWithDrag } from '../src/sim/physics/aero';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World } from '../src/sim/world';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

describe('ball aerodynamics (pure)', () => {
  it('drag opposes the flow, ~4× larger side-on than nose-on; a spiral is turned toward its flight only in free air', () => {
    const v: Vec3 = [0, 0, 25];
    const nose = ballAir(v, [0, 0, 1], [0, 0, 0], true), side = ballAir(v, [1, 0, 0], [0, 0, 0], true);
    expect(nose.force[2]).toBeLessThan(0);
    expect(nose.force[0]).toBeCloseTo(0);
    expect(side.force[2] / nose.force[2]).toBeCloseTo(BALL_AERO.cdSide / BALL_AERO.cdNose);
    // ~0.5 N at 25 m/s nose-on (≈ 1.2 m/s² on 0.41 kg)
    expect(-nose.force[2]).toBeGreaterThan(0.3);
    expect(-nose.force[2]).toBeLessThan(0.8);
    // a spiral whose nose points 30° above its flight: the torque moves its spin axis down toward the flight
    const axis: Vec3 = [0, Math.sin(0.5), Math.cos(0.5)], spin: Vec3 = [0, 60 * axis[1], 60 * axis[2]];
    const t = ballAir(v, axis, spin, true).torque, perp = [0, Math.cos(0.5), -Math.sin(0.5)];
    expect(t[1] * perp[1] + t[2] * perp[2]).toBeLessThan(0);
    expect(ballAir(v, axis, spin, false).torque).toEqual([0, 0, 0]);       // touching something: no
    expect(ballAir(v, axis, [0, 0, 1], true).torque).toEqual([0, 0, 0]);  // not spinning: no
  });

  it('a long throw falls short through the air, and the aim through the air puts it back on its point on time', () => {
    const from: Vec3 = [0, 2, 0], vel: Vec3 = [0, 17.7, 17.7], T = 2 * 17.7 / 9.81;
    const vac: Vec3 = [0, 2, 17.7 * T], air = flyWithDrag(from, vel, T, BALL_AERO.cdNose);
    console.log(`45° at 25 m/s: ${(vac[2] - air[2]).toFixed(1)} m short through the air`);
    expect(vac[2] - air[2]).toBeGreaterThan(2);
    const aimed = aimThroughAir(from, vel, T, BALL_AERO.cdNose), hit = flyWithDrag(from, aimed, T, BALL_AERO.cdNose);
    expect(Math.hypot(hit[0] - vac[0], hit[1] - vac[1], hit[2] - vac[2])).toBeLessThan(0.01);
    expect(Math.hypot(...aimed) - 25).toBeLessThan(2.5);
  });
});

describe('ball aerodynamics (World)', () => {
  /** A loose ball launched in an empty World: horizontal speed and the angle between its nose and its flight. */
  async function flight(vel: Vec3, spin: Vec3, seconds: number) {
    const w = await World.create(mujocoEngine, { physics: STD, seed: 1, assist: 0, athletes: [],
      props: [{ name: 'ball', shape: 'ellipsoid', size: [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2], mass: BALL.mass, pos: [0, 2, 0], friction: 0.8, turf: BALL_TURF }] });
    w.scene.placeProp(0, [0, 2, 0], qaxis([-vel[1], vel[0], 0], Math.acos(vel[2] / Math.hypot(...vel)))); // nose along the flight
    w.scene.launchProp(0, vel, spin);
    let maxOff = 0;
    for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
      w.step();
      const v = w.scene.propVel(0), a = qrot(w.scene.propPose(0).quat, [0, 0, 1]), s = Math.hypot(...v);
      maxOff = Math.max(maxOff, Math.acos(Math.min(1, Math.abs(a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / s)));
    }
    const v = w.scene.propVel(0), out = { horiz: Math.hypot(v[0], v[2]), maxOff, inst: w.scene.stats().instabilities };
    w.destroy();
    return out;
  }

  it('a spiral slows down along a long arc and keeps its nose on the curving flight; without spin it does not', async () => {
    const vel: Vec3 = [0, 15, 20];
    const sp = await flight(vel, [0, 0, 63], 2.5), flat = await flight(vel, [0, 0, 0], 2.5);
    console.log(`spiral: horizontal ${sp.horiz.toFixed(2)} m/s after 2.5 s (launched 20), nose off its flight by ≤ ${(sp.maxOff * 57.3).toFixed(0)}°; no spin: ≤ ${(flat.maxOff * 57.3).toFixed(0)}°`);
    expect(sp.inst + flat.inst).toBe(0);
    expect(sp.horiz).toBeLessThan(19.5);
    expect(sp.horiz).toBeGreaterThan(17);
    // the flight turns ~70° from climb to descent; a spiral follows it, a ball with no spin keeps its launch attitude
    expect(sp.maxOff).toBeLessThan(0.35);
    expect(flat.maxOff).toBeGreaterThan(0.8);
  });
});
