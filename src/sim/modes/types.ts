// Game modes are data: options the menu shows, a setup (who stands where, on which team, with which brain, where the
// ball starts) and rules (when the play ends, what it scores). Play (play.ts) runs any of them.
import type { QbTuning } from '../brains/football/qbTuning';
import type { CatchTuning } from './catching';
import type { AthleteParams } from '../anatomy/body';
import type { JumpTuning } from '../anim/jump';
import type { SupportSettings } from '../anim/types';
import type { BotDifficulty } from '../brains/carrier';
import type { Brain } from '../brains/types';
import type { Gains } from '../control/hand';
import type { Gait } from '../control/types';
import type { Vec3 } from '../math';
import type { PropDesc } from '../physics/engine';
import type { Rng } from '../rng';
import type { PhysicsSettings } from '../world';
import type { Play } from './play';

/** What the game hands every mode: physics, the player's and the bots' bodies, difficulty and the owner's knobs. */
export interface PlayConfig {
  physics: PhysicsSettings;
  assist: number;
  seed: number;
  human: AthleteParams;
  bot: AthleteParams;
  difficulty: BotDifficulty;
  /** A bot carrier's cruise gait (he bursts to a sprint when engaged). */
  carrierGait: Gait;
  traction?: number;
  gains?: Partial<Gains>;
  /** Active-ragdoll support for every athlete; absent = old balance assist only. */
  support?: SupportSettings;
  /** Every bot's support toughness (WorldSetup athletes' toughness; 1 = the player's). */
  toughness?: number;
  /** Arcade hit power (WorldSetup.hitPower; 1 = pure physics). */
  hitPower?: number;
  /** Catch tuning overrides (catching.ts; absent = the defaults). The same for every athlete. */
  catching?: Partial<CatchTuning>;
  /** Bot QB tuning (brains/football/qbTuning.ts: skill and habits; absent = the defaults). */
  qb?: Partial<QbTuning>;
  /** Jump tuning for every athlete (WorldSetup.jump; absent / {} = the defaults). */
  jump?: Partial<JumpTuning>;
  /** Defenders' difficulty (TacklerBrain: the AI tackling setting); absent = difficulty. */
  defense?: BotDifficulty;
  /** Bone strength of the human and of every bot (AthleteSetup.boneStrength; 1 = the measured tolerances). */
  boneStrength?: number; aiBoneStrength?: number;
  /** Waiting bots play the wait (a gauntlet tackler holds his zone and mirrors the runner) instead of idling at their
   *  spot: the game sets it on high-end presets. */
  activeBots?: boolean;
}

/** One menu control. Ranges are in the unit shown (yards, seconds, counts). */
export type OptionDesc =
  | { id: string; label: string; kind: 'range'; min: number; max: number; step: number; default: number; unit?: string }
  | { id: string; label: string; kind: 'toggle'; default: boolean }
  | { id: string; label: string; kind: 'choice'; default: string; choices: { id: string; label: string }[] };
export type OptionValue = number | boolean | string;
export type ModeOptions = Record<string, OptionValue>;

/** Field geometry and scoring. Team 0 attacks +Z, team 1 −Z: team 0 scores with the ball past z > goal[0], team 1
 *  past z < goal[1]; the end lines close the end zones behind them. */
export interface Rules {
  /** Sidelines at |x| = halfWidth (m). */
  halfWidth: number;
  goal: [number, number];
  endLine: [number, number];
  /** Out of bounds ends the play (a runner touching the turf beyond a line, a loose ball on the turf beyond one). */
  outOfBounds: boolean;
  /** Safety stop (s): a play nobody finishes ends here. */
  timeLimit: number;
  points: { touchdown: number; safety: number; fieldGoal: number };
}

/** One athlete. Index 0 is the single player's human, on team 0. */
export interface PlayerSpec {
  team: 0 | 1;
  /** The position's name in the lobby's position menu ('Returner', 'Blocker 2', 'Gunner L'), unique within his team. */
  label: string;
  /** The unit it belongs to there ('Kicking team', 'Offense'); absent: just its team. */
  group?: string;
  /** Start position on the turf (x, z), m. */
  pos: [number, number];
  /** Facing (rad, 0 = +Z); default: toward the goal his team attacks. */
  yaw?: number;
  /** Body; default: the config's human (index 0) or bot body. */
  params?: AthleteParams;
}

export type BallStart = { holder: number } | { at: Vec3; impetus: 0 | 1 };

export interface PlaySetup {
  players: PlayerSpec[];
  ball: BallStart;
  rules: Rules;
  /** Extra props (cones, bags) after the ball and the barrier walls. */
  props?: PropDesc[];
  /** The line of scrimmage (z, m): one forward pass is allowed from behind it (docs/passing.md); absent: no passing. */
  los?: number;
  /** A bot's brain whenever possession changes (and at the start); null = the default role: the ball holder runs
   *  (CarrierBrain), his teammates block (BlockerBrain), the other team tackles (TacklerBrain, which also chases a
   *  loose ball). */
  brain?(play: Play, i: number, rng: Rng): Brain | null;
  /** Mode logic after the shared rules, every step while the play is live (kicks, field goals, special ends). */
  step?(play: Play): void;
  /** After the play ends: adjust play.scorer / play.points / play.verdict (e.g. a drill's win for either side). */
  ended?(play: Play): void;
  /** The result in words from team `team`'s side (play.human: the viewer's athlete), read from state every screen has,
   *  so a multiplayer guest words his own; '' = the shared verdict or the default words. */
  verdict?(play: Play, team: 0 | 1): string;
  /** One HUD line about the mode (your role, the score to beat). */
  status?(play: Play): string;
}

export interface ModeDef {
  id: string;
  title: string;
  /** One or two sentences for the menu card. */
  pitch: string;
  /** Preview picture, a path under public/ (e.g. 'modes/oklahoma.jpg', rendered by art/modes/render.ts). */
  preview: string;
  options: OptionDesc[];
  /** Athletes on the field with these options (the menu warns when it may run slowly). */
  athletes(o: ModeOptions): number;
  /** Build one play. `rng` is the rep's seeded stream (positions may vary per rep). */
  setup(o: ModeOptions, rng: Rng, cfg: PlayConfig): PlaySetup;
}
