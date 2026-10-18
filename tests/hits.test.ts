// World.hits: one event per body-part pair in contact, with force and closing speed (sound and feel use it).
import { beforeAll, expect, it } from 'vitest';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { collide, technique } from './helpers/contact';
import type { HitEvent } from '../src/sim/world';

beforeAll(() => mujocoEngine.init());

it('reports segment pairs, force and closing speed for a head-on hit', async () => {
  let first: HitEvent[] | null = null, maxSpeed = 0;
  await collide({ speed: 6, script: technique.upright }, { speed: 6, script: technique.upright }, 1, { hz: 240, iterations: 30, detail: 'standard' }, 0.6, {
    onStep: (w) => {
      if (!first && w.hits.length) first = w.hits;
      for (const h of w.hits) maxSpeed = Math.max(maxSpeed, h.speed);
      const sum = w.hits.reduce((s, h) => s + h.force, 0);
      expect(sum).toBeCloseTo(w.lastHitForce, 6);
    },
  });
  expect(first).not.toBeNull();
  const h = first![0];
  expect(h.a).not.toBe(h.b);
  expect(typeof h.segA).toBe('string');
  expect(h.force).toBeGreaterThan(0);
  expect(maxSpeed).toBeGreaterThan(5); // ~12 m/s closing; segments slow on impact
});
