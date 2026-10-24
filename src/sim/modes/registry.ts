// Every game mode, in menu order. To add one, write a ModeDef (types.ts) in its own file here and list it below.
import { DRIVE } from './drive';
import { ELEVEN } from './eleven';
import { FIELD_GOAL_BLOCK } from './fieldGoalBlock';
import { GAUNTLET } from './gauntlet';
import { GOAL_LINE_STAND } from './goalline';
import { HIT_STICK } from './hitstick';
import { HOT_POTATO } from './hotPotato';
import { INFECTION } from './infection';
import { KEEP_AWAY } from './keepaway';
import { KICKOFF } from './kickoff';
import { KICKOFF_RETURN } from './kickoffReturn';
import { OKLAHOMA } from './oklahoma';
import { OPEN_FIELD_CARRY, OPEN_FIELD_TACKLE } from './openField';
import { PASS_MODE } from './pass';
import { PASS_RUSH } from './passRush';
import { PUNT_BLOCK } from './puntBlock';
import { PUNT_RETURN } from './puntReturn';
import { SCRAMBLE } from './scramble';
import { SUMO } from './sumo';
import { SURVIVAL } from './survival';
import { Rng } from '../rng';
import type { ModeDef, ModeOptions, OptionDesc, OptionValue, PlayConfig } from './types';

export const MODES: ModeDef[] = [OPEN_FIELD_TACKLE, OPEN_FIELD_CARRY, OKLAHOMA, KICKOFF_RETURN, KICKOFF, PUNT_RETURN, PUNT_BLOCK, FIELD_GOAL_BLOCK, GAUNTLET, SUMO, KEEP_AWAY, SCRAMBLE, GOAL_LINE_STAND, HIT_STICK, PASS_MODE, PASS_RUSH, DRIVE, ELEVEN, SURVIVAL, HOT_POTATO, INFECTION];

/** Above this many athletes a mode may run slowly on a low-end device (docs/physics-benchmark.md). */
export const SLOW_ATHLETES = 4;

export const modeById = (id: string): ModeDef => MODES.find((m) => m.id === id) ?? MODES[0];

/** One option's value from stored data (remembered settings, a URL): the default unless it is valid. */
function valid(d: OptionDesc, v: unknown): OptionValue {
  if (d.kind === 'toggle') return typeof v === 'boolean' ? v : d.default;
  if (d.kind === 'choice') return d.choices.some((c) => c.id === v) ? (v as string) : d.default;
  if (typeof v !== 'number' || !Number.isFinite(v)) return d.default;
  return Math.min(d.max, Math.max(d.min, Math.round((v - d.min) / d.step) * d.step + d.min));
}

/** A mode's options: every descriptor's value from `stored` where valid, else its default. */
export function resolveOptions(m: ModeDef, stored: Record<string, unknown> = {}): ModeOptions {
  return Object.fromEntries(m.options.map((d) => [d.id, valid(d, stored[d.id])]));
}

/** One position of a mode, for the lobby's position menu (multiplayer): the athlete index it plays. */
export interface SlotInfo { index: number; team: 0 | 1; label: string; group?: string }

/** A mode's positions with these options, without building a world. Start spots vary per rep; indices and labels
 *  depend only on the options. (No setup reads the config: shortcut, pass a real one if a setup ever does.) */
export function listSlots(m: ModeDef, o: ModeOptions = resolveOptions(m)): SlotInfo[] {
  return m.setup(o, new Rng(1), {} as PlayConfig).players.map((p, index) => ({ index, team: p.team, label: p.label, ...(p.group && { group: p.group }) }));
}
