// The balance assist must steady posture, never tip it: its torque has to point back toward upright.
import { beforeAll, describe, expect, it } from 'vitest';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World } from '../src/sim/world';
import { standScenario } from '../src/sim/scenarios';

beforeAll(() => mujocoEngine.init());

describe('balance assist', () => {
  it.each([[0.2, 0], [0, 0.2]])('torque restores a tilted pelvis (tilt about x %s rad, about z %s rad)', async (ax, az) => {
    const w = await World.create(mujocoEngine, standScenario({ hz: 240, iterations: 30, detail: 'standard' }, 1).setup);
    const a = w.athletes[0], s = w.scene.athletes[0].state, pi = a.segIndex.get('pelvis')!;
    a.feet[0].touching = true;
    // tilt: rotation of angle θ about axis n → quaternion (x, y, z, w) as stored by the scene
    const th = Math.hypot(ax, az), n = [ax / th, 0, az / th];
    s.segQuat.set([n[0] * Math.sin(th / 2), 0, n[2] * Math.sin(th / 2), Math.cos(th / 2)], 4 * pi);
    s.segAngVel.fill(0);
    const torques: number[][] = [];
    w.scene.applyWrench = (_ai: number, seg: number, _f: number[], t: number[]) => { if (seg === pi) torques.push(t); };
    (w as unknown as { applyAssist(a: unknown): void }).applyAssist(a);
    const t = torques.find((x) => x.some((v) => v !== 0))!;
    // restoring torque opposes the tilt rotation
    expect(t[0] * ax + t[2] * az).toBeLessThan(0);
    w.destroy();
  });
});
