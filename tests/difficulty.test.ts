// Difficulty axes and arcade hit power (owner decisions 2026-10-18): bot toughness through its support only,
// bot juking skill through its brain only, hit power 1 = pure physics.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { carrierSkill } from '../src/sim/brains/carrier';
import { ScriptBrain } from '../src/sim/brains/script';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import type { World } from '../src/sim/world';
import { collide, technique, type Side } from './helpers/contact';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const drive: Side = { speed: 8, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 95 } };
const jogger: Side = { speed: 4, script: technique.upright, params: { ...DEFAULT_ATHLETE, mass: 95 } };

/** A low drive at 8 m/s into an upright jogger: every body state of every step, and what happened to the jogger. */
async function hardHit(seed: number, opts: { hitPower?: number; toughnessB?: number } = {}) {
  const states: number[] = [];
  let t0 = -1, z0 = 0, back = NaN, stun = 0;
  const r = await collide(drive, jogger, seed, STD, 2, {
    support: { ...DEFAULT_SUPPORT }, ...opts,
    onStep: (w: World) => {
      for (const a of w.scene.athletes) states.push(...a.state.segPos, ...a.state.qd);
      const b = w.scene.athletes[1].state;
      if (t0 < 0 && w.lastHitForce > 0) { t0 = w.time; z0 = b.com[2]; }
      if (t0 >= 0 && Number.isNaN(back) && w.time - t0 >= 0.6) back = b.com[2] - z0;
      stun = Math.max(stun, w.athletes[1].stun);
    },
  });
  return { states, back, stun, down: r.bDown, hitterDown: r.aDown, instabilities: r.instabilities };
}

describe('hit power', () => {
  it('1 is pure physics: bit-identical to no hit power, in a hard hit and a drill rep', async () => {
    expect((await hardHit(1, { hitPower: 1 })).states).toEqual((await hardHit(1)).states);
    const rep = async (hitPower?: number) => {
      const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, hitPower }, new ScriptBrain((_t, _p, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; }), 0);
      const out: number[] = [];
      while (d.repTime < 3 && !d.ended) { d.step(); for (const a of d.world.scene.athletes) out.push(...a.state.segPos); }
      d.destroy();
      return out;
    };
    expect(await rep(1)).toEqual(await rep());
  });

  it('above 1 the athlete hit is blown back farther; the hitter driving through is not', async () => {
    let back1 = 0, back25 = 0, hitterDown = 0, instabilities = 0;
    const n = 4;
    for (let seed = 1; seed <= n; seed++) {
      const a = await hardHit(seed, { hitPower: 1 }), b = await hardHit(seed, { hitPower: 2.5 });
      back1 += a.back / n; back25 += b.back / n; hitterDown += +b.hitterDown; instabilities += a.instabilities + b.instabilities;
    }
    console.log(`jogger driven back in the 0.6 s after a hard hit: hit power 1 ${back1.toFixed(2)} m, 2.5 ${back25.toFixed(2)} m; hitter down at 2.5: ${hitterDown}/${n}`);
    expect(back25).toBeGreaterThan(back1 + 1);
    expect(hitterDown).toBeLessThanOrEqual(1);
    expect(instabilities).toBe(0);
  });
});

describe('bot toughness', () => {
  it('a tougher bot is stunned less and downed no more often by the same hit', async () => {
    const rate = async (T: number) => {
      let stun = 0, down = 0;
      for (let seed = 1; seed <= 8; seed++) { const r = await hardHit(seed, { toughnessB: T }); stun += r.stun / 8; down += +r.down; }
      return { stun, down };
    };
    const soft = await rate(0.6), tough = await rate(1.6);
    console.log('hard hit on a bot of toughness 0.6', soft, '1.6', tough);
    expect(soft.stun).toBeGreaterThan(tough.stun + 0.2);
    expect(soft.down).toBeGreaterThanOrEqual(tough.down);
  });
});

describe('bot juking', () => {
  /** Sprints at where the carrier will be 0.4 s on (a decent angle), wraps when close. */
  const chaser = () => new ScriptBrain((_t, p, c) => {
    const me = p.athletes[p.self], b = p.athletes[1 - p.self];
    if (me.down) return;
    const d0 = Math.hypot(b.com[0] - me.com[0], b.com[2] - me.com[2]), L = Math.min(0.4, d0 / 10);
    const dx = b.com[0] + b.comVel[0] * L - me.com[0], dz = b.com[2] + b.comVel[2] * L - me.com[2], d = Math.hypot(dx, dz) || 1;
    c.gait = 'sprint'; c.move = { x: dx / d, z: dz / d };
    if (d0 < 2.5) { c.contactMode = true; c.armL = c.armR = 1; c.gripL = c.gripR = true; c.wrap = d0 < 1.4; }
  });
  it('a straight chase with a decent angle tackles an easy carrier most reps and a hard one rarely', async () => {
    const tackled = async (juking: number) => {
      let n = 0;
      for (let rep = 0; rep < 8; rep++) {
        const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, timeLimit: 8, difficulty: carrierSkill(juking) }, chaser(), rep);
        while (!d.ended) d.step();
        n += +(d.ended === 'down');
        d.destroy();
      }
      return n;
    };
    const easy = await tackled(0), normal = await tackled(0.5), hard = await tackled(1);
    console.log(`tackled of 8 by a straight chase: easy ${easy}, normal ${normal}, hard ${hard}`);
    expect(easy).toBeGreaterThanOrEqual(5);
    expect(easy).toBeGreaterThanOrEqual(normal);
    expect(normal).toBeGreaterThanOrEqual(hard);
    expect(hard).toBeLessThanOrEqual(2);
  });
});
