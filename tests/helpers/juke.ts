// Juke recovery (owner item 2026-10-18): a scripted carrier runs at the bot tackler and cuts hard past it; how far
// the tackler overruns him and how long it runs away from him (tests/brains.test.ts).
import { ScriptBrain } from '../../src/sim/brains/script';
import { DIFFICULTY } from '../../src/sim/brains/carrier';
import { BARRIER, DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../../src/sim/drills/openField';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import type { PhysicsSettings } from '../../src/sim/world';

export interface JukeResult {
  /** Farthest the tackler ran (> 1.5 m/s) more than 90° away from the carrier in one go, after the cut (m). */
  overrun: number;
  /** Longest stretch the tackler ran (> 1.5 m/s) more than 90° away from the carrier, after the cut (s). */
  lost: number;
  /** Closest the tackler got to a wall (m) and whether it touched one. */
  wallGap: number; wall: boolean;
  touched: boolean; ended: string | null; instabilities: number;
}

/** The carrier (the drill's human, attacking +Z) jogs at the tackler and, `at` m from it, plants and cuts `angle` rad
 *  off straight ahead (+ to his left), then sprints on that line for `seconds` s. */
export async function juke(angle: number, physics: PhysicsSettings, opts: { at?: number; seed?: number; seconds?: number } = {}): Promise<JukeResult> {
  let cutAt = -1;
  const carrier = new ScriptBrain((t, p, c) => {
    const me = p.athletes[p.self], o = p.athletes[1 - p.self];
    if (me.down || t < 0) return;
    const d = Math.hypot(o.com[0] - me.com[0], o.com[2] - me.com[2]);
    if (cutAt < 0 && d < (opts.at ?? 4)) cutAt = t;
    c.gait = cutAt < 0 ? 'jog' : 'sprint';
    // (upfield again short of the sideline: the run is the tackler's to read, not a race into the wall)
    c.move = cutAt < 0 || Math.abs(me.com[0]) > 8 ? { x: 0, z: 1 } : { x: Math.sin(angle), z: Math.cos(angle) };
    if (cutAt >= 0 && t - cutAt < 0.12) c.plantCut = angle > 0 ? 1 : -1;
  });
  const dr = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics, mode: 'carry', difficulty: DIFFICULTY.normal, timeLimit: 30 }, carrier, opts.seed ?? 0);
  const w = dr.world, T = 1, C = 0, sc = w.scene.athletes[C].state, st = w.scene.athletes[T].state;
  const r: JukeResult = { overrun: 0, lost: 0, wallGap: Infinity, wall: false, touched: false, ended: null, instabilities: 0 };
  let lostT = 0, lostD = 0;
  const end = w.time + (opts.seconds ?? 4);
  while (w.time < end && !dr.ended) {
    dr.step();
    r.touched ||= w.athletes[T].playerContact;
    // (a tackle may carry both into the wall: only the chase counts)
    if (r.touched) continue;
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) if (p.athlete === T && o.athlete < 0 && o.seg > 0) r.wall = true;
    r.wallGap = Math.min(r.wallGap, BARRIER.halfWidth - Math.abs(st.com[0]), BARRIER.halfLength - Math.abs(st.com[2]));
    if (cutAt < 0) continue;
    const dx = sc.com[0] - st.com[0], dz = sc.com[2] - st.com[2], sp = Math.hypot(st.comVel[0], st.comVel[2]);
    const away = sp > 1.5 && (st.comVel[0] * dx + st.comVel[2] * dz) / (sp * Math.hypot(dx, dz)) < 0;
    lostT = away ? lostT + w.dt : 0; lostD = away ? lostD + sp * w.dt : 0;
    r.lost = Math.max(r.lost, lostT); r.overrun = Math.max(r.overrun, lostD);
  }
  r.ended = dr.ended; r.instabilities = w.scene.stats().instabilities;
  dr.destroy();
  return r;
}
