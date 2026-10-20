// The tuning groups' one merge (catching, the bot QB, jumps): stored settings and a host's start message are trust
// boundaries, so only known knobs holding finite numbers are kept, each clamped to its range.

/** `defaults` with `o`'s valid knobs on top: unknown keys and non-numbers dropped, numbers clamped to [lo, hi]
 *  (ranges[k][0], ranges[k][1]). */
export function tuned<T extends object>(defaults: T, ranges: Record<keyof T, readonly number[]>, o: unknown): T {
  const out = { ...defaults };
  if (o && typeof o === 'object') for (const k of Object.keys(defaults) as (keyof T)[]) {
    const v = (o as Record<keyof T, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(ranges[k][1], Math.max(ranges[k][0], v)) as T[keyof T];
  }
  return out;
}
