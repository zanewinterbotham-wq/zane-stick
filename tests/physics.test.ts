import { beforeAll, describe, expect, it } from 'vitest';
import { buildBody, DEFAULT_ATHLETE, totalMass } from '../src/sim/anatomy/body';
import { mujocoEngine } from '../src/sim/physics/mujoco';

beforeAll(() => mujocoEngine.init());

describe.each(['standard', 'minimum'] as const)('MuJoCo scene, %s detail', (detail) => {
  const plan = buildBody(DEFAULT_ATHLETE, detail);
  it('whole-body COM at rest matches the plan and a limp body collapses without exploding', () => {
    const sc = mujocoEngine.createScene({ hz: 240, iterations: 50, athletes: [{ plan, pos: [0, 0, 0], yaw: 0 }], props: [] });
    const s = sc.athletes[0].state;
    expect(s.com[1]).toBeGreaterThan(0.95);
    let maxV = 0;
    for (let i = 0; i < 240 * 3; i++) {
      sc.step();
      for (let k = 0; k < s.segVel.length; k++) maxV = Math.max(maxV, Math.abs(s.segVel[k]));
    }
    expect(Number.isFinite(s.com[1])).toBe(true);
    expect(s.com[1]).toBeLessThan(0.45); // fell down
    expect(s.com[1]).toBeGreaterThan(0.05); // but did not sink into the ground
    expect(maxV).toBeLessThan(12);
    sc.destroy();
  });
  it('two limp athletes colliding at 9 m/s each stay finite', () => {
    const sc = mujocoEngine.createScene({ hz: 240, iterations: 50, athletes: [{ plan, pos: [0, 0, -0.7], yaw: 0 }, { plan: buildBody(DEFAULT_ATHLETE, detail), pos: [0, 0, 0.7], yaw: Math.PI }], props: [] });
    // Give everyone forward velocity by a short push on every segment.
    for (let n = 0; n < 24; n++) {
      sc.athletes.forEach((a, ai) => a.plan.segments.forEach((sg, si) => sc.applyWrench(ai, si, [0, 0, (ai === 0 ? 1 : -1) * sg.mass * 9 / (24 * sc.dt)], [0, 0, 0])));
      sc.step();
    }
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      sc.step();
      for (const c of sc.contacts()) if (c.a.athlete >= 0 && c.b.athlete >= 0 && c.a.athlete !== c.b.athlete) peak = Math.max(peak, c.force);
    }
    expect(peak).toBeGreaterThan(1000);
    for (const a of sc.athletes) expect(Number.isFinite(a.state.com[0])).toBe(true);
    expect(sc.stats().instabilities).toBe(0);
    sc.destroy();
  });
});

describe('grip constraint', () => {
  it('holds a load and reports the force', () => {
    const plan = buildBody(DEFAULT_ATHLETE);
    // Athlete placed 1 m off the ground so the grip must carry the whole body.
    const sc = mujocoEngine.createScene({ hz: 240, iterations: 50, athletes: [{ plan, pos: [0, 1, 0], yaw: 0 }],
      props: [{ name: 'bar', shape: 'box', size: [0.5, 0.02, 0.02], mass: 0, pos: [0, 3.6, 0] }] });
    const hand = plan.segments.findIndex((s) => s.name === 'handL');
    const p = sc.athletes[0].state.segCom;
    sc.gripOn(0, 0, { athlete: -1, seg: 0 }, [p[3 * hand], p[3 * hand + 1], p[3 * hand + 2]], 0.025);
    // Hanging by one hand from a fixed point: averaged over the swing, the grip carries about the body weight.
    let sum = 0, n = 0;
    for (let i = 0; i < 240 * 4; i++) { sc.step(); if (i >= 240 * 2) { sum += sc.gripForce(0, 0); n++; } }
    expect(sc.gripActive(0, 0)).toBe(true);
    expect(sc.stats().instabilities).toBe(0);
    const w = totalMass(plan) * 9.81;
    expect(sum / n).toBeGreaterThan(0.8 * w);
    expect(sum / n).toBeLessThan(1.4 * w);
    sc.destroy();
  });
});
