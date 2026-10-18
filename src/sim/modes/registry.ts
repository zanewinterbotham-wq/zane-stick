// Every game mode, in menu order. To add one, write a ModeDef (types.ts) in its own file here and list it below.
import { OKLAHOMA } from './oklahoma';
import { OPEN_FIELD_CARRY, OPEN_FIELD_TACKLE } from './openField';
import type { ModeDef, ModeOptions, OptionDesc, OptionValue } from './types';

export const MODES: ModeDef[] = [OPEN_FIELD_TACKLE, OPEN_FIELD_CARRY, OKLAHOMA];

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
