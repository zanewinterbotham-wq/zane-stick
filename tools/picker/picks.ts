// The picks file (art/picks.json): what the owner chose in the dev picker. Read by the game's build later.

export interface Picks {
  version: 1;
  /** categoryId -> picked variantIds; the game picks randomly among them. */
  sounds: Record<string, string[]>;
  /** style id under art/characters/, or null when none chosen yet. */
  character: string | null;
  /** stadium id under art/stadiums/; absent or null until chosen (older picks files have no such field). */
  stadium?: string | null;
  /** categoryId -> gain multiplier (1 = as recorded). */
  volumes: Record<string, number>;
  notes: string;
}

export const MAX_VOLUME = 4;

export function emptyPicks(): Picks {
  return { version: 1, sounds: {}, character: null, volumes: {}, notes: '' };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Checks the shape and returns a clean copy with only the known fields. */
export function validate(x: unknown): { ok: true; picks: Picks } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ['picks must be a JSON object'] };
  if (x.version !== 1) errors.push('version must be 1');
  const sounds: Record<string, string[]> = {};
  if (!isObj(x.sounds)) errors.push('sounds must be an object');
  else for (const [cat, ids] of Object.entries(x.sounds)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0)) errors.push(`sounds.${cat} must be a list of variant ids`);
    else if (new Set(ids).size !== ids.length) errors.push(`sounds.${cat} has duplicate ids`);
    else if (ids.length) sounds[cat] = [...ids];
  }
  if (x.character !== null && (typeof x.character !== 'string' || !x.character)) errors.push('character must be a style id or null');
  if (x.stadium != null && (typeof x.stadium !== 'string' || !x.stadium)) errors.push('stadium must be a stadium id or null');
  const volumes: Record<string, number> = {};
  if (!isObj(x.volumes)) errors.push('volumes must be an object');
  else for (const [cat, v] of Object.entries(x.volumes)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_VOLUME) errors.push(`volumes.${cat} must be a number from 0 to ${MAX_VOLUME}`);
    else volumes[cat] = v;
  }
  if (typeof x.notes !== 'string') errors.push('notes must be a string');
  if (errors.length) return { ok: false, errors };
  return { ok: true, picks: { version: 1, sounds, character: x.character as string | null, ...(x.stadium ? { stadium: x.stadium as string } : {}), volumes, notes: x.notes as string } };
}
