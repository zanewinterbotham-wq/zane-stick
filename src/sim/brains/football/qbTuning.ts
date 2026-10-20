// QB tuning (owner request 2026-10-19: a setting to make the bot QB better; tweakable in the Tuning panel and exported
// with the rest). Skill is the bot QB's reaction and precision over the full range (difficulty = reaction / decision /
// precision only, CLAUDE.md); the other knobs are his decision habits. Game-design values, not measurements.
import type { BotDifficulty } from '../carrier';

export interface QbTuning {
  /** 0..1: how late he sees the field (reaction 0.65 → 0.05 s) and how noisy his reads and leads are (0.68 → 0.02). */
  skill: number;
  /** A read takes look + lookK × reaction s. */
  look: number; lookK: number;
  /** Lead error per unit of noise (m at the release, plus aimPerM per m of throw). */
  aim: number; aimPerM: number;
  /** How much pressure on him (0..1) adds to the lead error (× (1 + nerves × pressure)). */
  nerves: number;
  /** A read's openness is misjudged by a gaussian of noise × misread. */
  misread: number;
  /** How open (0..1, sense.openness) a receiver must look before he throws to him. */
  open: number;
}

export const QB_DEFAULTS: QbTuning = { skill: 0.5, look: 0.15, lookK: 1.2, aim: 0.5, aimPerM: 0.04, nerves: 1.5, misread: 0.5, open: 0.3 };

/** Each knob's range and slider step. */
export const QB_RANGES: Record<keyof QbTuning, [number, number, number]> = {
  skill: [0, 1, 0.01], look: [0.02, 0.5, 0.01], lookK: [0, 2.5, 0.05], aim: [0, 2, 0.05], aimPerM: [0, 0.12, 0.005], nerves: [0, 4, 0.1], misread: [0, 1.5, 0.05], open: [0, 0.9, 0.01],
};

/** Defaults with valid overrides applied (unknown keys and bad values dropped, values clamped to their range). */
export function qbTuning(o: unknown): QbTuning {
  const out = { ...QB_DEFAULTS };
  if (o && typeof o === 'object') for (const k of Object.keys(QB_DEFAULTS) as (keyof QbTuning)[]) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(QB_RANGES[k][1], Math.max(QB_RANGES[k][0], v));
  }
  return out;
}

/** The bot QB's reaction and noise at a skill: 0.5 is about what he had from the juking setting at its default
 *  (reaction 0.35 s, noise 0.35); 1 reads the field 0.05 s late with almost no noise. */
export const qbSkill = (k: number): BotDifficulty => ({ reaction: 0.05 + 0.6 * (1 - k), noise: 0.02 + 0.66 * (1 - k) });
