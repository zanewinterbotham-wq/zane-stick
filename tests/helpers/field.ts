// A headless field for the football brains' tests (docs/passing.md "AI built for 11 on 11"): any number of offense
// and defense athletes at play-frame alignments, each with a brain, a script or the default role brain, the ball
// tucked in one athlete's hands, and step/run helpers that record positions and separation. Built on Play (the
// shared rules, the ball tuck, catching) with a small test mode, so whatever a brain does here it does in a mode.
import { DIFFICULTY, type BotDifficulty } from '../../src/sim/brains/carrier';
import { rel, separation, toWorld } from '../../src/sim/brains/football/sense';
import type { Assignment, PlayCall } from '../../src/sim/brains/football/types';
import { ScriptBrain } from '../../src/sim/brains/script';
import type { Brain, Perception } from '../../src/sim/brains/types';
import type { AthleteParams } from '../../src/sim/anatomy/body';
import type { Commands } from '../../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../../src/sim/drills/openField';
import { Play } from '../../src/sim/modes/play';
import { attackDir, NFL } from '../../src/sim/modes/rules';
import type { ModeDef, Rules } from '../../src/sim/modes/types';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import type { Rng } from '../../src/sim/rng';
import type { PhysicsSettings, World } from '../../src/sim/world';
import { STD } from './scenario';

/** A football brain's constructor shape (docs/passing.md): `(...a) => new QbBrain(...a)`. */
export type BrainFactory = (rng: Rng, diff: BotDifficulty, call: PlayCall, self: number) => Brain;

export interface FieldPlayer {
  /** Alignment in the play frame: world x (m) and depth downfield of the LOS (m; the offense lines up at ≤ 0). */
  x: number; depth: number;
  /** A brain (instance or factory), or a script (t: s since the snap, < 0 in the pre-roll); none: the role brain
   *  (the holder carries, his mates block, the other team tackles). */
  brain?: Brain | BrainFactory;
  script?: (t: number, p: Perception, c: Commands) => void;
  assign?: Assignment;
  /** Facing (rad, 0 = +Z); default: toward the other team. */
  yaw?: number;
  params?: AthleteParams;
  diff?: BotDifficulty;
}

export interface FieldSpec {
  offense: FieldPlayer[]; defense: FieldPlayer[];
  /** Index of the athlete who holds the ball (offense first, then defense); default 0. */
  ball?: number;
  /** Line of scrimmage (world z, m; default 0) and the offense's team (default 0: it attacks +z). */
  los?: number; offenseTeam?: 0 | 1;
  seed?: number; physics?: PhysicsSettings; diff?: BotDifficulty;
  /** Default: NFL rules with out of bounds off and a 10 min limit (the field never ends a test early). */
  rules?: Partial<Rules>;
  /** One forward pass allowed from behind the line (PlaySetup.los, as the 'pass' mode): a Commands.pass is thrown by
   *  the World, and the play ends incomplete on the turf. Default off (a pass command is ignored). */
  passing?: boolean;
}

/** One sample of a run: time since the snap (s), every athlete's play-frame position and his separation (m, to the
 *  nearest standing opponent). */
export interface FieldSample { t: number; pos: { x: number; depth: number }[]; sep: number[] }

export interface Field {
  play: Play; world: World; call: PlayCall;
  /** Athlete indices of the offense and of the defense. */
  offense: number[]; defense: number[];
  /** The brain each athlete thinks with (a factory's product, the ScriptBrain, or null: the role brain). */
  brains: (Brain | null)[];
  /** Time since the snap (s). */
  readonly t: number;
  step(n?: number): void;
  /** Run `seconds` s, sampling every `every` s (and once at the start); stops early when `until` says so. */
  run(seconds: number, opts?: { every?: number; until?: (f: Field) => boolean; each?: (f: Field) => void }): FieldSample[];
  sample(): FieldSample;
  perception(i: number): Perception;
  /** Play-frame position of athlete i. */
  pos(i: number): { x: number; depth: number };
  instabilities(): number;
  destroy(): void;
}

const { carrier, timeLimit: _t, mode: _m, ...BASE } = DEFAULT_OPEN_FIELD;

export async function buildField(spec: FieldSpec): Promise<Field> {
  await mujocoEngine.init();
  const team = spec.offenseTeam ?? 0, dir = attackDir(team), los = spec.los ?? 0, diff = spec.diff ?? DIFFICULTY.normal;
  const players = [...spec.offense, ...spec.defense], nOff = spec.offense.length;
  const rules: Rules = { ...NFL, outOfBounds: false, timeLimit: 600, ...spec.rules };
  // the frame object is shared with every brain: its snapTime is set once the pre-roll is over
  const call: PlayCall = { frame: { los, dir, halfWidth: rules.halfWidth, snapTime: 0 }, offense: team, assign: players.map((p) => p.assign ?? null) };
  const brains: (Brain | null)[] = players.map(() => null);
  const def: ModeDef = {
    id: 'field', title: 'Test field', pitch: '', preview: '', options: [], athletes: () => players.length,
    setup: () => ({
      players: players.map((p, i) => {
        const w = toWorld(call.frame, p.depth, p.x), t = i < nOff ? team : (1 - team) as 0 | 1;
        return { team: t, label: `${i < nOff ? 'O' : 'D'}${i}`, pos: [w[0], w[2]], yaw: p.yaw ?? (attackDir(t) > 0 ? 0 : Math.PI), params: p.params };
      }),
      ball: { holder: spec.ball ?? 0 }, rules, los: spec.passing ? los : undefined,
      // one brain per athlete for the whole play (a change of possession keeps it); none: the role brain
      brain: (_play, i, rng) => {
        const p = players[i];
        if (!brains[i] && p.script) { const fn = p.script; brains[i] = new ScriptBrain((t, per, c) => fn(t - call.frame.snapTime, per, c)); }
        if (!brains[i] && p.brain) brains[i] = typeof p.brain === 'function' ? p.brain(rng, p.diff ?? diff, call, i) : p.brain;
        return brains[i];
      },
    }),
  };
  const play = await Play.create(mujocoEngine, { ...BASE, physics: spec.physics ?? STD, bot: carrier, seed: spec.seed ?? 1, difficulty: diff }, def, {}, null, 0, { human: -1 });
  call.frame.snapTime = play.repStart;
  const w = play.world, idx = players.map((_, i) => i);
  const f: Field = {
    play, world: w, call, brains, offense: idx.slice(0, nOff), defense: idx.slice(nOff),
    get t() { return w.time - call.frame.snapTime; },
    step(n = 1) { for (let k = 0; k < n; k++) play.step(); },
    perception: (i) => w.perception(i),
    pos: (i) => { const r = rel(call.frame, w.scene.athletes[i].state.com as unknown as [number, number, number]); return { x: r.x, depth: r.depth }; },
    sample() { const p = w.perception(0); return { t: f.t, pos: idx.map((i) => f.pos(i)), sep: idx.map((i) => separation(p, i)) }; },
    run(seconds, o = {}) {
      const every = Math.max(1, Math.round((o.every ?? 0.1) / w.dt)), out = [f.sample()], n = Math.round(seconds / w.dt);
      for (let k = 1; k <= n && !o.until?.(f); k++) { play.step(); o.each?.(f); if (k % every === 0) out.push(f.sample()); }
      return out;
    },
    instabilities: () => w.scene.stats().instabilities,
    destroy: () => play.destroy(),
  };
  return f;
}
