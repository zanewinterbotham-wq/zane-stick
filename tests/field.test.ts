// The headless field builder (tests/helpers/field.ts) the football brains' tests stand on: alignments land where the
// play frame says, the ball is in the holder's hands, scripts and brain factories run, and separation is recorded,
// 1 v 1 and 2 v 2, either way the offense attacks.
import { describe, expect, it } from 'vitest';
import { DIFFICULTY, type BotDifficulty } from '../src/sim/brains/carrier';
import type { PlayCall } from '../src/sim/brains/football/types';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Perception } from '../src/sim/brains/types';
import type { Commands } from '../src/sim/control/types';
import { buildField, type FieldPlayer } from './helpers/field';

/** A receiver sprinting straight downfield (a go route) from the snap. */
const go = (t: number, p: Perception, c: Commands) => { if (t < 0) return; c.move = { x: 0, z: p.field.dirZ }; c.gait = 'sprint'; };
/** A defender in off man on receiver `j`: aims `cushion` m downfield of where he will be in 0.3 s, sprinting. */
const cover = (j: number, cushion = 7) => (t: number, p: Perception, c: Commands) => {
  if (t < 0) return;
  const me = p.athletes[p.self].com, r = p.athletes[j], dz = p.field.dirZ;
  const x = r.com[0] + r.comVel[0] * 0.3 - me[0], z = r.com[2] + r.comVel[2] * 0.3 + cushion * dz - me[2], d = Math.hypot(x, z) || 1;
  c.move = { x: x / d, z: z / d }; c.gait = 'sprint';
};
/** A QB who stands in the pocket holding the ball (no brain: the role brain would run with it). */
const QB: FieldPlayer = { x: 0, depth: -5, script: () => {} };

describe('field builder', () => {
  it('1 v 1 (QB, a receiver, a corner): aligned in the play frame, ball in the QB\'s hands, the go route runs with an off man keeping his cushion', async () => {
    const f = await buildField({ offense: [QB, { x: 12, depth: -0.5, script: go, assign: { kind: 'route', route: 'go' } }], defense: [{ x: 12, depth: 6, script: cover(1) }] });
    expect(f.offense).toEqual([0, 1]); expect(f.defense).toEqual([2]);
    expect(f.call.assign[1]).toEqual({ kind: 'route', route: 'go' });
    expect(f.call.frame.snapTime).toBeCloseTo(f.world.time);
    const start = f.sample();
    for (const [i, p] of [[0, QB], [1, { x: 12, depth: -0.5 }], [2, { x: 12, depth: 6 }]] as const) {
      expect(Math.abs(start.pos[i].x - p.x)).toBeLessThan(0.3); expect(Math.abs(start.pos[i].depth - p.depth)).toBeLessThan(0.3);
    }
    expect(f.world.ballCarrier).toBe(0);
    const s = f.run(3);
    const ball = f.play.ballPos(), qb = f.world.scene.athletes[0].state.com;
    console.log(`field 1v1: WR depth ${s.at(-1)!.pos[1].depth.toFixed(1)} m, CB depth ${s.at(-1)!.pos[2].depth.toFixed(1)} m, separation ${s.map((x) => x.sep[1].toFixed(1)).filter((_, k) => k % 5 === 0).join(' ')} m, instabilities ${f.instabilities()}`);
    expect(s.length).toBe(31);
    expect(s.at(-1)!.pos[1].depth).toBeGreaterThan(15);
    expect(Math.hypot(ball[0] - qb[0], ball[2] - qb[2])).toBeLessThan(0.6);
    expect(f.world.ballCarrier).toBe(0);
    expect(f.instabilities()).toBe(0);
    for (const a of f.world.athletes) expect(a.downBy).toBeNull();
    f.destroy();
  });

  it('2 v 2, offense attacking −z from z = 10: brain factories get (rng, diff, call, self); each corner covers his own man', async () => {
    const got: { self: number; call: PlayCall; diff: BotDifficulty }[] = [];
    const f = await buildField({
      los: 10, offenseTeam: 1,
      offense: [QB, { x: -12, depth: -0.5, script: go }, { x: 10, depth: -0.5, script: go }],
      defense: [{ x: -12, depth: 6, script: cover(1) }, {
        x: 10, depth: 6,
        brain: (_rng, diff, call, self) => { got.push({ self, call, diff }); const s = cover(2); return new ScriptBrain((t, p, c) => s(t - call.frame.snapTime, p, c)); },
      }],
    });
    expect(f.call.frame).toMatchObject({ los: 10, dir: -1 });
    expect(got).toHaveLength(1); expect(got[0].self).toBe(4); expect(got[0].call).toBe(f.call); expect(got[0].diff).toBe(DIFFICULTY.normal);
    expect(f.world.athletes.map((a) => a.setup.team)).toEqual([1, 1, 1, 0, 0]);
    // depth 6 downfield of z = 10 for an offense going −z is z = 4
    expect(f.world.scene.athletes[3].state.com[2]).toBeCloseTo(4, 0);
    const end = f.run(3).at(-1)!;
    console.log(`field 2v2: WR depths ${end.pos[1].depth.toFixed(1)} / ${end.pos[2].depth.toFixed(1)} m, separations ${end.sep[1].toFixed(1)} / ${end.sep[2].toFixed(1)} m, CB x ${end.pos[3].x.toFixed(1)} / ${end.pos[4].x.toFixed(1)}, instabilities ${f.instabilities()}`);
    expect(end.pos[1].depth).toBeGreaterThan(15); expect(end.pos[2].depth).toBeGreaterThan(15);
    // each corner stays on his own man's side of the field
    expect(end.pos[3].x).toBeLessThan(-6); expect(end.pos[4].x).toBeGreaterThan(5);
    expect(f.world.ballCarrier).toBe(0);
    expect(f.instabilities()).toBe(0);
    f.destroy();
  });
});
