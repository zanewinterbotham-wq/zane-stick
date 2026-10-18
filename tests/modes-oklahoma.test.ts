// The Oklahoma drill runs headlessly with the human in each role (a bot brain standing in for him): the blocker
// and the defender meet, the rep ends inside its time limit with one side winning, and nothing diverges.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockerBrain } from '../src/sim/brains/blocker';
import { CarrierBrain, DIFFICULTY } from '../src/sim/brains/carrier';
import { TacklerBrain } from '../src/sim/brains/tackler';
import type { AthleteView, Brain, Perception } from '../src/sim/brains/types';
import { OKLAHOMA, type OklahomaRole } from '../src/sim/modes/oklahoma';
import { Play } from '../src/sim/modes/play';
import { resolveOptions } from '../src/sim/modes/registry';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };
const stand: Record<OklahomaRole, () => Brain> = {
  defender: () => new TacklerBrain(new Rng(5), DIFFICULTY.normal),
  blocker: () => new BlockerBrain(new Rng(5), DIFFICULTY.normal),
  carrier: () => new CarrierBrain(new Rng(5), DIFFICULTY.normal, 'jog'),
};

describe('BlockerBrain', () => {
  const v = (com: [number, number, number], team: 0 | 1, hasBall = false): AthleteView => ({ com, comVel: [0, 0, 0], pelvis: com, head: [com[0], 1.8, com[2]], heading: 0, down: false, hasBall, team });
  /** Carrier at the origin attacking +Z, blockers 0 and 1 at −x and +x, threats 3 (−x) and 4 (+x). */
  const field = (): Perception => ({ time: 0, self: 0, field: { halfWidth: 24, goalZ: 45, dirZ: 1 },
    athletes: [v([-2, 1, 3], 0), v([2, 1, 3], 0), v([0, 1, 0], 0, true), v([-3, 1, 9], 1), v([3, 1, 8], 1)] });
  it('shares the threats out (each blocker takes the one he is nearest) and runs to the spot between his man and the carrier', () => {
    const b = [0, 1].map((self) => { const x = new BlockerBrain(new Rng(1), { reaction: 0, noise: 0 }); x.think({ ...field(), self }, 1 / 240); return x; });
    expect(b.map((x) => x.target)).toEqual([3, 4]);
    // the +x threat is the more urgent; with him down, both take the −x one
    const p = field(); p.athletes[4].down = true;
    let c = b[1].think({ ...p, self: 1, time: 1 }, 1 / 240);
    for (let i = 1; i < 60; i++) c = b[1].think({ ...p, self: 1, time: 1 + i / 240 }, 1 / 240);
    expect(b[1].target).toBe(3);
    expect(c.move.x).toBeLessThan(0); // toward the −x threat's block point
    expect(c.move.z).toBeGreaterThan(0);
  });
});

describe('Oklahoma drill', () => {
  for (const role of ['defender', 'blocker', 'carrier'] as OklahomaRole[]) {
    it(`runs with the human as the ${role}`, async () => {
      const out: string[] = [];
      for (let rep = 0; rep < 3; rep++) {
        const p = await Play.create(mujocoEngine, CFG, OKLAHOMA, resolveOptions(OKLAHOMA, { role }), stand[role](), rep);
        const w = p.world, blk = w.athletes.findIndex((a, i) => a.setup.team === w.athletes[w.ballCarrier].setup.team && i !== w.ballCarrier);
        const def = w.athletes.findIndex((a) => a.setup.team !== w.athletes[w.ballCarrier].setup.team);
        expect(w.athletes.length).toBe(3);
        expect(w.athletes[0].setup.team).toBe(0);
        let met = -1;
        while (!p.ended) { p.step(); if (met < 0 && w.athletes[blk].touching.includes(def)) met = p.repTime; }
        out.push(`${p.ended} (${p.verdict}) at ${p.repTime.toFixed(1)} s, block at ${met.toFixed(2)} s`);
        expect(met).toBeGreaterThanOrEqual(0);
        expect(met).toBeLessThan(1.5);
        expect(p.repTime).toBeLessThanOrEqual(10 + w.dt);
        expect(p.points).toBe(1);
        expect(p.verdict).toMatch(/wins/);
        expect(w.scene.stats().instabilities).toBe(0);
        p.destroy();
      }
      console.log(`Oklahoma, human ${role}:`, out.join('; '));
    }, 180_000);
  }
});
