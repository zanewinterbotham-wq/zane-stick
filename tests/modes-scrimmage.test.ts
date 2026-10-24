// Plays from scrimmage (scrimmage.ts) and the modes built on them: Drive (downs and distance carried across reps),
// Pass Rush (a scrambling bot QB against your rush) and 11 on 11. Lineups are well formed (every receiver covered once
// in man, three deep in zone, linemen out of coverage), the drive's down logic is the NFL's, and headless plays run
// to an end with the solver stable while the drive carries its spot into the next rep.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Brain } from '../src/sim/brains/types';
import { neutralCommands } from '../src/sim/control/types';
import { currentDrive, decodeDrive, downText, DRIVE, encodeDrive, freshDrive, nextDown, resetDrive } from '../src/sim/modes/drive';
import { ELEVEN } from '../src/sim/modes/eleven';
import { ownYard } from '../src/sim/modes/kicks';
import { PASS_RUSH } from '../src/sim/modes/passRush';
import { Play } from '../src/sim/modes/play';
import { resolveOptions } from '../src/sim/modes/registry';
import { scrimmage } from '../src/sim/modes/scrimmage';
import type { ModeDef, ModeOptions } from '../src/sim/modes/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { CFG } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

describe('drive downs (pure)', () => {
  it('ten yards is a first down, short of it the next down, a fourth-down miss turns it over', () => {
    const d = freshDrive(25);
    expect(d).toEqual({ down: 1, spot: 25, line: 35, over: '' });
    expect(nextDown(d, { spot: 29 })).toEqual({ down: 2, spot: 29, line: 35, over: '' });
    expect(nextDown({ ...d, down: 3 }, { spot: 36 })).toEqual({ down: 1, spot: 36, line: 46, over: '' });
    expect(nextDown({ ...d, down: 2, spot: 30 }, 'incomplete')).toEqual({ down: 3, spot: 30, line: 35, over: '' });
    expect(nextDown({ ...d, down: 4, spot: 33 }, { spot: 34 }).over).toBe('downs');
    expect(nextDown(d, 'turnover').over).toBe('turnover');
    expect(nextDown(d, 'td').over).toBe('td');
    // inside the 10 it is goal to go
    const g = freshDrive(94);
    expect(g.line).toBe(100);
    expect(downText(g)).toBe('1st & goal at their 6');
    expect(downText({ down: 3, spot: 40, line: 44, over: '' })).toBe('3rd & 4 at your 40');
  });

  it('the drive survives the trip through play.note', () => {
    for (const d of [freshDrive(5), { down: 4, spot: 99, line: 100, over: '' as const }, { ...freshDrive(50), over: 'downs' as const }]) expect(decodeDrive(encodeDrive(d))).toEqual(d);
    expect(encodeDrive({ down: 4, spot: 99, line: 100, over: 'turnover' }).length).toBeLessThanOrEqual(40); // the snapshot's note limit
    expect(decodeDrive('BLOCKED')).toBeNull();
  });
});

describe('lineups', () => {
  it('11 on 11: eleven a side, unique labels, every eligible receiver covered by one man in Cover 1, three deep in Cover 3', () => {
    for (const coverage of ['man', 'zone'] as const) {
      const ps = scrimmage({ O: 0, los: 0, side: 1, ol: 5, wr: 3, te: true, rb: true, dl: 4, lb: 3, cb: 2, s: 2, coverage, run: false, scramble: false }, new Rng(3));
      expect(ps.players.length).toBe(22);
      for (const t of [0, 1] as const) {
        const mine = ps.players.filter((p) => p.team === t);
        expect(mine.length).toBe(11);
        expect(new Set(mine.map((p) => p.label)).size).toBe(11);
      }
      expect(ps.order[0]).toBe('qb');
      const routes = ps.jobs.flatMap((a, i) => (a.kind === 'route' ? [i] : []));
      expect(routes.length).toBe(5);
      expect(ps.jobs.filter((a) => a.kind === 'block').length).toBe(5);
      expect(ps.jobs.filter((a) => a.kind === 'rush').length).toBe(4);
      const qb = ps.jobs[0];
      expect(qb.kind === 'pass' && qb.reads.map((r) => r.target).sort()).toEqual(routes.sort());
      if (coverage === 'man') {
        const men = ps.jobs.flatMap((a) => (a.kind === 'man' ? [a.target] : []));
        expect(men.sort()).toEqual(routes.sort());
      } else expect(ps.jobs.filter((a) => a.kind === 'zone' && a.zone === 'deep-third').length).toBe(3);
    }
  });

  it('a run is a direct snap to the back, everyone else blocks; any position can be the human (athlete 0)', () => {
    const ps = scrimmage({ O: 1, los: 0, side: -1, ol: 5, wr: 3, te: true, rb: true, dl: 4, lb: 3, cb: 2, s: 2, coverage: 'man', run: true, scramble: false, human: 'lb1' }, new Rng(1));
    expect(ps.order[0]).toBe('lb1');
    expect(ps.players[0].team).toBe(0);
    expect('holder' in ps.ball && ps.order[ps.ball.holder]).toBe('rb');
    expect(ps.jobs.some((a) => a.kind === 'route' || a.kind === 'pass')).toBe(false);
    for (const perSide of ['11', '7']) for (const pos of ['auto', 'te', 'ol2', 'wr2', 'dl0', 'lb1', 'cb0', 's1']) {
      const o = { ...resolveOptions(ELEVEN), perSide, position: pos }, s = ELEVEN.setup(o, new Rng(2), CFG);
      expect(s.players[0], `${perSide} ${pos}`).toMatchObject({ team: 0, group: /^(dl|lb|cb|s)/.test(pos) ? 'Defense' : 'Offense' });
      expect(s.players.length).toBe(ELEVEN.athletes(o));
    }
  });

  it('Pass Rush: the human is a rusher on defense and the bot QB may scramble', () => {
    const o = resolveOptions(PASS_RUSH), s = PASS_RUSH.setup({ ...o, blockers: 2, mates: 1 }, new Rng(1), CFG) as ReturnType<typeof scrimmage>;
    expect(s.players[0]).toMatchObject({ team: 0, group: 'Defense' });
    expect(s.jobs[0].kind).toBe('rush');
    const qb = s.jobs.find((a) => a.kind === 'pass');
    expect(qb?.kind === 'pass' && qb.scramble).toBe(true);
    expect(s.players.length).toBe(PASS_RUSH.athletes({ ...o, blockers: 2, mates: 1 }));
  });
});

/** The human's role played by the bot brain the play gives athlete 0 (as the preview pictures do). */
function autoHuman(get: () => Play | null): Brain {
  let cur: Brain | null = null;
  return { think(p, dt) {
    const play = get();
    if (!play) return neutralCommands();
    cur ??= play.roleBrain(0);
    return cur.think(p, dt);
  } };
}
async function rep(def: ModeDef, o: ModeOptions, n = 0, secs = Infinity) {
  let play: Play | null = null;
  play = await Play.create(mujocoEngine, CFG, def, o, autoHuman(() => play), n);
  while (!play.ended && play.repTime < secs) play.step();
  console.log(`${def.id} rep ${n}: ${play.ended} at ${play.repTime.toFixed(2)} s, "${play.verdict}", note "${play.note}"`);
  expect(play.world.scene.stats().instabilities, def.id).toBe(0);
  return play;
}

describe('headless plays', () => {
  it('Drive: a play ends, the drive goes on from where it was spotted', { timeout: 120_000 }, async () => {
    resetDrive();
    const o = resolveOptions(DRIVE);
    const p0 = await rep(DRIVE, o, 0);
    const d = decodeDrive(p0.note)!;
    expect(d).not.toBeNull();
    expect(currentDrive(o)).toEqual(d.over ? freshDrive(+o.start) : d);
    p0.destroy();
    const p1 = await rep(DRIVE, o, 1, 1);
    // the next play's line of scrimmage is the spot (a new drive from the start after a drive ended)
    expect(p1.mode.los).toBeCloseTo(ownYard(0, d.over ? +o.start : d.spot), 6);
    p1.destroy();
    resetDrive();
  });

  it('Pass Rush: the play runs to its end', { timeout: 120_000 }, async () => {
    const p = await rep(PASS_RUSH, resolveOptions(PASS_RUSH));
    expect(p.ended).not.toBeNull();
    p.destroy();
  });

  it('11 on 11: 22 athletes step stably through the snap and the first seconds', { timeout: 180_000 }, async () => {
    const t = Date.now(), p = await rep(ELEVEN, { ...resolveOptions(ELEVEN), coverage: 'man' }, 0, 2.5);
    console.log(`11 on 11: ${((Date.now() - t) / p.world.steps).toFixed(2)} ms per step (build included)`);
    expect(p.world.athletes.length).toBe(22);
    p.destroy();
  });
});
