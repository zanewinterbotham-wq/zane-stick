// Whole pass plays with every football brain (docs/passing.md "AI built for 11 on 11"), headless on the test field
// with the forward pass rules: the bot QB's Commands.pass thrown by the World (the motion, the release, the error),
// bot receivers, bot defensive backs. 2 v 2 (man and zone) over seeds: some passes complete, some picked off, some
// incomplete; 3 v 3 (zone: deep third, flat, hook; and man): stable, and every brain does its job.
import { describe, expect, it } from 'vitest';
import { DefensiveBackBrain, zoneLandmark } from '../src/sim/brains/football/db';
import { QBBrain } from '../src/sim/brains/football/qb';
import { ReceiverBrain } from '../src/sim/brains/football/receiver';
import type { Assignment, ManAssign, PassAssign, RouteKind, ZoneAssign } from '../src/sim/brains/football/types';
import { DIFFICULTY, type BotDifficulty } from '../src/sim/brains/carrier';
import { buildField, type FieldPlayer } from './helpers/field';

const qb = (pass: Omit<PassAssign, 'kind'>): FieldPlayer => ({ x: 0, depth: -1, assign: { kind: 'pass', ...pass }, brain: (r, d, c, s) => new QBBrain(r, d, c, s) });
const wr = (x: number, route: RouteKind): FieldPlayer => ({ x, depth: -0.5, assign: { kind: 'route', route }, brain: (r, d, c, s) => new ReceiverBrain(r, d, c, s) });
const db = (x: number, depth: number, assign: ManAssign | ZoneAssign): FieldPlayer => ({ x, depth, assign, brain: (r, d, c, s) => new DefensiveBackBrain(r, d, c, s) });
const man = (target: number, press: boolean): ManAssign => ({ kind: 'man', target, press, leverage: 'inside', help: 'none' });
const zone = (z: ZoneAssign['zone'], side: -1 | 0 | 1): ZoneAssign => ({ kind: 'zone', zone: z, side });

interface Rep { pass: string; ended: string | null; target: number; kind: string; open: number; at: number; by: number; inst: number; zoneOut: number[]; shared: number; samples: number; hand: number; miss: number; chance: string; early: number; deepest: number[]; matches: number[] }

/** One play to its result: until the pass is caught (and 0.3 s on), dead, or `secs` s. Before the throw it records
 *  how far each zone defender strays out of his zone (m beyond its radius), in man the share of samples in which two
 *  defenders are each nearest the same receiver (no two on one man), how many samples a defender was playing a ball
 *  not yet thrown (`early`), and how deep each receiver got (m); at the end the receiver each defender is on. */
async function play(offense: FieldPlayer[], defense: FieldPlayer[], seed: number, secs = 7, diff: BotDifficulty = DIFFICULTY.normal): Promise<Rep> {
  const f = await buildField({ offense, defense, seed, passing: true, diff });
  const nOff = offense.length, qbb = f.brains[0] as QBBrain;
  const zoneOut = defense.map(() => 0);
  let shared = 0, samples = 0, caughtAt = NaN, hand = Infinity, miss = NaN, early = 0;
  const deepest = offense.map(() => -Infinity);
  f.run(secs, {
    every: 0.05,
    until: (g) => !!g.play.ended || (!Number.isNaN(caughtAt) && g.world.time > caughtAt + 0.3),
    each: (g) => {
      const p = g.play;
      if ((p.pass === 'complete' || p.pass === 'intercepted') && Number.isNaN(caughtAt)) caughtAt = g.world.time;
      // the throw: how near the target's hands it came, and how far he was from it as it came down through the aim's
      // height (the lead's miss)
      const lp = qbb.lastPass, w = g.world;
      if (p.pass === 'air' && lp && lp.target >= 0) {
        const b = p.ballPos(), c = w.scene.athletes[lp.target].state.com;
        for (const h of [0, 1] as const) { const q = w.handPoint(w.athletes[lp.target], h); hand = Math.min(hand, Math.hypot(q[0] - b[0], q[1] - b[1], q[2] - b[2])); }
        if (Number.isNaN(miss) && b[1] < lp.cmd.at[1] && w.scene.propVel(p.ball)[1] < 0) miss = Math.hypot(b[0] - c[0], b[2] - c[2]);
      }
      if (p.pass !== 'none' || qbb.lastPass || g.t < 0) return;
      for (let r = 1; r < nOff; r++) deepest[r] = Math.max(deepest[r], g.pos(r).depth);
      early += defense.filter((_, k) => (g.brains[nOff + k] as DefensiveBackBrain).phase === 'ball').length;
      const near: number[] = [];
      defense.forEach((d, k) => {
        const i = nOff + k, at = g.pos(i), a = d.assign as Assignment;
        if (a.kind === 'zone') {
          const L = zoneLandmark(g.call.frame, a);
          zoneOut[k] = Math.max(zoneOut[k], Math.hypot(at.depth - L.depth, at.x - L.x) - L.r);
        } else {
          let best = -1, bd = Infinity;
          for (let r = 1; r < nOff; r++) { const q = g.pos(r), dd = Math.hypot(q.x - at.x, q.depth - at.depth); if (dd < bd) { bd = dd; best = r; } }
          near.push(best);
        }
      });
      samples++;
      if (new Set(near).size < near.length) shared++;
    },
  });
  const lp = qbb.lastPass, p = f.play;
  const r: Rep = { pass: p.pass, ended: p.ended, target: lp?.target ?? -9, kind: lp?.kind ?? '-', open: lp?.open ?? NaN, at: lp ? lp.t - f.call.frame.snapTime : NaN, by: p.lastCatch?.athlete ?? -1, inst: f.instabilities(), zoneOut, shared, samples, hand, miss, early, deepest, matches: defense.map((_, k) => (f.brains[nOff + k] as DefensiveBackBrain).match), chance: p.lastCatch ? `${p.lastCatch.chance.toFixed(2)} ${Object.entries(p.lastCatch.factors).filter(([, v]) => v < 0.99).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' ')}` : '' };
  f.destroy();
  return r;
}
const line = (r: Rep) => `${r.pass.padEnd(11)} to ${r.target} (${r.kind}, open ${r.open.toFixed(2)}, at ${r.at.toFixed(2)} s): came ${r.hand.toFixed(2)} m from his hands, ${r.miss.toFixed(2)} m from him at the aim's height; last catch try by ${r.by} ${r.chance}`;

const PAIRS: [RouteKind, RouteKind][] = [['slant', 'out'], ['go', 'curl'], ['in', 'post'], ['curl', 'slant'], ['out', 'go'], ['post', 'in'], ['dig', 'hitch'], ['comeback', 'seam']];

describe('pass plays, every brain a bot, the real throw', () => {
  it('2 v 2 (QB + 2 WR vs 2 DB, man and zone) over seeds: completions, interceptions and incompletions', async () => {
    const reps: { cov: string; seed: number; r: Rep }[] = [];
    for (const lvl of ['easy', 'normal', 'hard'] as const) for (const [k, [r1, r2]] of PAIRS.entries()) for (const cov of ['man', 'zone'] as const) {
      const seed = k + 1, press = k % 2 === 0;
      const defense = cov === 'man'
        ? [db(12, press ? 1 : 6, man(1, press)), db(-12, press ? 1 : 6, man(2, press))]
        : [db(9, 7, zone(k % 2 ? 'curl' : 'flat', 1)), db(-4, 12, zone('deep-half', -1))];
      const r = await play([qb({ drop: 5, reads: [{ target: 1, by: 2.6 }, { target: 2, by: 3.3 }], scramble: false }), wr(12, r1), wr(-12, r2)], defense, seed, 7, DIFFICULTY[lvl]);
      console.log(`2 v 2 ${lvl} ${cov.padEnd(4)} ${press ? 'press' : 'off  '} ${r1}/${r2} seed ${seed}: ${line(r)}`);
      reps.push({ cov, seed, r });
      expect(r.inst).toBe(0);
    }
    const n = (s: string) => reps.filter((x) => x.r.pass === s).length;
    console.log(`2 v 2 over ${reps.length} plays: complete ${n('complete')}, intercepted ${n('intercepted')}, incomplete ${n('incomplete')} (thrown away ${reps.filter((x) => x.r.kind === 'away').length}), no pass ${n('none')}`);
    expect(n('complete')).toBeGreaterThan(0);
    expect(n('intercepted')).toBeGreaterThan(0);
    expect(n('incomplete')).toBeGreaterThan(0);
  }, 600_000);

  it('3 v 3 (QB + 3 WR vs 3 DB): zone (deep third, flat, hook) and man are stable, zone defenders hold their zones and no two men share a receiver', async () => {
    const offense = (seed: number) => [qb({ drop: 5, reads: [{ target: 1, by: 2.6 }, { target: 2, by: 3.2 }, { target: 3, by: 3.8 }], scramble: false }),
      wr(14, seed % 2 ? 'go' : 'out'), wr(6, seed % 2 ? 'slant' : 'curl'), wr(-13, seed % 2 ? 'curl' : 'post')];
    for (const seed of [1, 2]) {
      const z = await play(offense(seed), [db(0, 13, zone('deep-third', 0)), db(13, 5, zone('flat', 1)), db(-5, 8, zone('hook', -1))], seed);
      console.log(`3 v 3 zone seed ${seed}: ${line(z)}; out of zone before the throw ${z.zoneOut.map((v) => v.toFixed(2)).join(' / ')} m; receivers as deep as ${z.deepest.slice(1).map((v) => v.toFixed(1)).join(' / ')} m before it`);
      expect(z.inst).toBe(0);
      for (const v of z.zoneOut) expect(v).toBeLessThan(1);
      expect(z.early).toBe(0);
      for (const v of z.deepest.slice(1)) expect(v).toBeGreaterThan(3);
      const m = await play(offense(seed), [db(14, 6, man(1, false)), db(6, 5, man(2, false)), db(-13, 1, man(3, true))], seed);
      console.log(`3 v 3 man  seed ${seed}: ${line(m)}; two defenders nearest one receiver in ${m.shared} of ${m.samples} samples before the throw; on receivers ${m.matches.join(' ')}`);
      expect(m.inst).toBe(0);
      expect(m.shared / Math.max(1, m.samples)).toBeLessThan(0.1);
      expect(m.matches).toEqual([1, 2, 3]);
      expect(m.early).toBe(0);
      for (const v of m.deepest.slice(1)) expect(v).toBeGreaterThan(3);
    }
  }, 600_000);
});
