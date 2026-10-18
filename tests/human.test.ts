import { describe, expect, it } from 'vitest';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

const view = (x: number, z: number, heading = 0): AthleteView => ({ com: [x, 1, z], comVel: [0, 0, 0], pelvis: [x, 1, z], head: [x, 1.8, z], heading, down: false, hasBall: false });
const perceive = (carrier: AthleteView): Perception => ({ time: 0, self: 0, athletes: [view(0, 0), { ...carrier, hasBall: true }], field: { halfWidth: 24, goalZ: 50, dirZ: 1 } });
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 1 }, torso: 0, sprint: 0, sink: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });

describe('HumanBrain', () => {
  it('switches contact mode on near a target ahead, with hysteresis, and off behind or far', () => {
    const b = new HumanBrain();
    b.latest = input();
    expect(b.think(perceive(view(0, 4.5))).contactMode).toBe(false);
    const c = b.think(perceive(view(0, 3.5)));
    expect(c.contactMode).toBe(true);
    expect(c.sink).toBeGreaterThan(0);                                // ready stance
    expect(b.think(perceive(view(0, 4.5))).contactMode).toBe(true);   // inside the off limit
    expect(b.think(perceive(view(0, 5.5))).contactMode).toBe(false);
    expect(b.think(perceive(view(0, -2))).contactMode).toBe(false);   // behind
  });

  it('thrust overrides sink and torso; an arm button raises and grips toward the camera aim', () => {
    const b = new HumanBrain();
    b.latest = input({ sink: 1, torso: 1, held: new Set(['thrust']) });
    let c = b.think(perceive(view(0, 3)));
    expect([c.thrustHips, c.sink, c.lean.fwd]).toEqual([true, 0, 0]);
    b.latest = input({ armL: 1, cameraYaw: Math.PI / 2, aimPitch: 0.3 });
    c = b.think(perceive(view(0, 20)));
    expect([c.armL, c.gripL, c.armR, c.gripR]).toEqual([1, true, 0, false]);
    expect(c.aim![0]).toBeGreaterThan(1);                              // camera looks along +X
    expect(c.aim![1]).toBeGreaterThan(1.5);                            // aimed above level
  });

  it('shift lock faces the camera way and moves camera-relative; off, it faces the move direction', () => {
    const b = new HumanBrain();
    b.latest = input({ move: { x: 1, y: 0 }, cameraYaw: Math.PI / 2, shiftLock: true });
    let c = b.think(perceive(view(0, 20)));
    expect(c.face!.x).toBeCloseTo(1); expect(c.face!.z).toBeCloseTo(0);  // camera looks along +X
    expect(c.move.x).toBeCloseTo(0); expect(c.move.z).toBeCloseTo(1);   // D = the camera's right
    b.latest = { ...b.latest, shiftLock: false };
    c = b.think(perceive(view(0, 20)));
    expect(c.face).toBeNull();
  });

  it('steer assist turns the run part way toward a carrier near and ahead, or a loose ball; not behind, far, or at 0', () => {
    const ang = (c: { move: { x: number; z: number } }) => Math.atan2(c.move.x, c.move.z);
    const steer = (k: number, p: Perception) => { const b = new HumanBrain(); b.steerAssist = k; b.latest = input(); return b.think(p); };
    // carrier 6 m away, 30° to the left (+X) of the straight-ahead stick
    const ahead = perceive(view(3, 5.2));
    const half = ang(steer(0.5, ahead)), full = ang(steer(1, ahead));
    expect(ang(steer(0, ahead))).toBeCloseTo(0, 6);
    expect(half).toBeGreaterThan(0.1); expect(half).toBeLessThan(Math.PI / 6);
    expect(full).toBeCloseTo(Math.PI / 6, 2);
    expect(Math.hypot(steer(1, ahead).move.x, steer(1, ahead).move.z)).toBeCloseTo(1, 6);   // the stick's magnitude is kept
    expect(ang(steer(1, perceive(view(0, -6))))).toBeCloseTo(0, 6);                        // behind
    expect(ang(steer(1, perceive(view(10, 17))))).toBeCloseTo(0, 6);                       // too far
    // nobody has the ball: it steers toward the loose ball instead
    const loose: Perception = { ...perceive(view(0, 30)), ball: { pos: [-2, 0.1, 4], vel: [0, 0, 0] } };
    loose.athletes[1].hasBall = false;
    expect(ang(steer(1, loose))).toBeCloseTo(Math.atan2(-2, 4), 2);
    // the human's own carry is never steered
    const mine = perceive(view(3, 5.2)); mine.athletes[0].hasBall = true; mine.athletes[1].hasBall = false;
    expect(ang(steer(1, mine))).toBeCloseTo(0, 6);
  });

  it('with shift lock, holding D shuffles sideways without turning the body (headless)', async () => {
    await mujocoEngine.init();
    const run = async (shiftLock: boolean) => {
      const h = new HumanBrain();
      const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, seed: 1, support: { ...DEFAULT_SUPPORT } }, h);
      const w = d.world, h0 = w.perception(0).athletes[0].heading;
      h.latest = input({ move: { x: 1, y: 0 }, cameraYaw: h0, shiftLock });
      let turn = 0;
      for (let i = 0, n = Math.round(1.5 / w.dt); i < n; i++) {
        d.step();
        const me = w.perception(0).athletes[0];
        turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(me.heading - h0), Math.cos(me.heading - h0))));
      }
      // velocity along the camera's right (-cos, sin) of the start heading
      const v = w.scene.athletes[0].state.comVel, side = -v[0] * Math.cos(h0) + v[2] * Math.sin(h0);
      const out = { turnDeg: turn * 180 / Math.PI, side, instabilities: w.scene.stats().instabilities };
      d.destroy();
      return out;
    };
    const on = await run(true), off = await run(false);
    console.log(`shift lock on: turned ${on.turnDeg.toFixed(1)}°, side speed ${on.side.toFixed(2)} m/s; off: turned ${off.turnDeg.toFixed(1)}°, side speed ${off.side.toFixed(2)} m/s`);
    expect(on.turnDeg).toBeLessThan(20);
    expect(on.side).toBeGreaterThan(0.8);
    expect(off.turnDeg).toBeGreaterThan(60);
    expect(on.instabilities + off.instabilities).toBe(0);
  });
});
