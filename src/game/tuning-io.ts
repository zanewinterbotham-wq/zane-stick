// Export / import of the Advanced tab's tuning values (pure: no DOM, so tests can run it). The JSON is the shape
// settings-menu shows in its Export box: speed, strength and the bone strengths as absolute values (the Settings
// fields are multipliers on PLAYER_BASE / BONE_BASE), support over GAME_SUPPORT, gains over DEFAULT_GAINS, and each
// tuning group through its own `tune` (validate + clamp + fill in the defaults).
import { DEFAULT_GAINS } from '../sim/control/hand';
import { BONE_BASE, GAME_SUPPORT, PLAYER_BASE, type Settings } from './settings';

/** What import needs of a TUNING group. */
export interface TuneGroup { key: string; ranges: Record<string, readonly number[]>; tune(o: unknown): object }

/** The flat "player" fields: [Settings field, the base its multiplier scales (1 = stored as is)]. */
const PLAYER: [keyof Settings, number][] = [['speed', PLAYER_BASE.speed], ['strength', PLAYER_BASE.strength], ['assist', 1], ['traction', 1],
  ['boneStrength', BONE_BASE.player], ['aiBoneStrength', BONE_BASE.ai], ['steerAssist', 1]];

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = (o: unknown, keys: string[]) => Object.fromEntries(keys.filter((k) => isObj(o) && num(o[k])).map((k) => [k, (o as Record<string, number>)[k]]));

/** Every tuning value of the tab, with the defaults filled in. */
export function exportTuning(s: Settings, groups: TuneGroup[]): Record<string, unknown> {
  return { support: s.support, speed: PLAYER_BASE.speed * s.speed, strength: PLAYER_BASE.strength * s.strength, assist: s.assist, traction: s.traction,
    boneStrength: BONE_BASE.player * s.boneStrength, aiBoneStrength: BONE_BASE.ai * s.aiBoneStrength, steerAssist: s.steerAssist,
    gains: { ...DEFAULT_GAINS, ...s.gains }, ...Object.fromEntries(groups.map((g) => [g.key, g.tune((s as unknown as Record<string, unknown>)[g.key])])) };
}

/** One category of the export (`key`: 'support', 'player', 'gains' or a group's key), in the shape it has in the main export. */
export function exportPart(s: Settings, groups: TuneGroup[], key: string): unknown {
  const all = exportTuning(s, groups);
  return key === 'player' ? Object.fromEntries(PLAYER.map(([k]) => [k, all[k]])) : all[key];
}

/** Apply exported JSON to `s`: the whole export, or with `key` just that category's part. Only known knobs are kept
 *  (validated through the group's `tune`); nothing changes unless something known was found. Returns an error line, or null. */
export function applyTuningJson(s: Settings, json: string, groups: TuneGroup[], key?: string): string | null {
  let o: unknown;
  try { o = JSON.parse(json); } catch { return 'That is not valid JSON.'; }
  if (!isObj(o)) return 'Expected a JSON object ({ … }).';
  if (key === 'player') o = pick(o, PLAYER.map(([k]) => k as string));
  else if (key) o = { [key]: o };
  const src = o as Record<string, unknown>, next: Record<string, unknown> = {};
  let n = 0;
  const sup = pick(src.support, Object.keys(GAME_SUPPORT));
  if (Object.keys(sup).length) { next.support = { ...GAME_SUPPORT, ...sup }; n++; }
  for (const [k, base] of PLAYER) {
    const v = src[k];
    if (num(v) && (base === 1 || v > 0)) { next[k] = v / base; n++; }
  }
  const gains = pick(src.gains, Object.keys(DEFAULT_GAINS));
  if (Object.keys(gains).length) { next.gains = { ...DEFAULT_GAINS, ...gains }; n++; }
  for (const g of groups) {
    const part = pick(src[g.key], Object.keys(g.ranges));
    if (Object.keys(part).length) { next[g.key] = g.tune(part); n++; }
  }
  if (!n) return 'No known tuning values found in that.';
  Object.assign(s, next);
  return null;
}
