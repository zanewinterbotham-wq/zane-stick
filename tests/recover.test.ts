// Getting going again (owner request 2026-10-18): after a big hit, or once back on his feet after a get-up, an athlete
// moves off at once on the move command, still a bit unsteady (he may stumble), instead of standing still until he
// is fully stable. Measured: time from separating (or from the end of the get-up) to 2 m/s along the command.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import type { Commands } from '../src/sim/control/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { collide, technique } from './helpers/contact';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

interface Go { hit: boolean; down: boolean; delay: number; getup: number }

/** A low drive at 8 m/s into an upright athlete at 4 m/s; once each is clear of the other (and up, if he went down)
 *  he sprints off sideways. Delay = clear → 2 m/s sideways, per athlete. */
async function getGoing(seed: number): Promise<[Go, Go]> {
  const st = [0, 1].map(() => ({ touched: false, wentDown: false, clearAt: -1, goAt: -1, want: false, upAt: -1 }));
  const go = (i: number, base: (t: number, c: Commands) => void) => (t: number, c: Commands) => {
    base(t, c);
    if (st[i].want) { c.move = { x: 1, z: 0 }; c.gait = 'sprint'; c.contactMode = false; c.sink = 0; c.lean = { fwd: 0, side: 0 }; c.driveLegs = 0; c.thrustHips = false; }
  };
  await collide({ speed: 8, script: go(0, technique.lowDrive) }, { speed: 4, script: go(1, technique.upright) }, seed, STD, 6, {
    support: { ...DEFAULT_SUPPORT },
    onStep: (w) => {
      w.athletes.forEach((a, i) => {
        const s = st[i], clip = a.controller.debug?.().clip;
        s.touched ||= a.playerContact; s.wentDown ||= !!a.downBy;
        // he wants to go as soon as he is apart from the other, down or not (a player holds the stick)
        s.want ||= s.touched && !a.playerContact && a.freeT > 0.1;
        if (clip === 'getup' && s.upAt < 0) s.upAt = w.time;
        // the clock starts when he is clear of the other and on his feet (it restarts if he goes down after all)
        if (a.downBy || clip === 'getup' || clip === 'down' || a.playerContact) { if (s.goAt < 0) s.clearAt = -1; }
        else if (s.touched && s.clearAt < 0 && a.freeT > 0.1) s.clearAt = w.time;
        if (s.clearAt >= 0 && s.goAt < 0 && w.scene.athletes[i].state.comVel[0] > 2) s.goAt = w.time;
      });
    },
  });
  return st.map((s) => ({ hit: s.touched, down: s.wentDown, delay: s.clearAt < 0 ? NaN : s.goAt < 0 ? Infinity : s.goAt - s.clearAt, getup: s.upAt < 0 || s.goAt < 0 ? NaN : s.goAt - s.upAt })) as [Go, Go];
}

describe('getting going again', () => {
  it('moves off within ~0.6 s of separating from a hit, and within 2 s of starting a get-up (2 m/s sideways)', async () => {
    const rows: string[] = [], delays: number[] = [], ups: number[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const r = await getGoing(seed);
      r.forEach((g, i) => {
        rows.push(`seed ${seed} ${i ? 'hit' : 'hitter'}: ${g.down ? `went down (get-up start → 2 m/s ${g.getup.toFixed(2)} s), ` : ''}2 m/s ${Number.isFinite(g.delay) ? `${g.delay.toFixed(2)} s` : String(g.delay)} after clear`);
        if (Number.isFinite(g.delay)) delays.push(g.delay);
        if (Number.isFinite(g.getup)) ups.push(g.getup);
      });
    }
    console.log('getting going:\n' + rows.join('\n'));
    expect(delays.length).toBeGreaterThan(6);
    expect(Math.max(...delays)).toBeLessThan(0.9);
    expect(delays.reduce((a, b) => a + b, 0) / delays.length).toBeLessThan(0.6);
    // from the start of a get-up to running: it hurries and hands over once both feet are under him (was 2 s + ~0.45 s)
    expect(ups.length).toBeGreaterThan(0);
    expect(Math.max(...ups)).toBeLessThan(2.0);
  }, 300_000);
});
