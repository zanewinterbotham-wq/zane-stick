// Player settings, remembered per browser. Storage can be unavailable (school-managed profiles, private
// windows), so every read and write is guarded and the defaults always work.
import { DEFAULT_SUPPORT, type SupportSettings } from '../sim/anim/types';
import type { PresetName } from './presets';

export interface Settings {
  preset: PresetName | null;     // null = not chosen yet (run the first-launch benchmark)
  assist: number;                // balance assist 0..1 (hand controller without support)
  support: SupportSettings;      // active-ragdoll support (tuning)
  strength: number;              // the player's muscle strength scale (difficulty)
  speed: number;                 // the player's max joint speed scale (difficulty)
  toughness: number;             // AI toughness: the bot's support thresholds × (difficulty; 1 = the player's)
  juking: number;                // AI juking skill 0..1 (difficulty)
  hitPower: number;              // arcade hit power, 1 = pure physics
  traction: number;              // cleat–turf friction (tuning)
  gains: Record<string, number>; // controller gain overrides (tuning)
  mute: boolean;
  effortShading: boolean;
  slowMo: boolean;
  autoCamera: boolean;            // camera follows the athlete (no mouse look needed)
  sprintToggle: boolean;          // sprint key toggles instead of hold
  sinkToggle: boolean;            // sink key toggles instead of hold
  camera: 'chase' | 'helmet';
  bindings: Record<string, string[]>; // the player's keyboard / mouse rebinds, per action, over bindings.json
  overlay: boolean;
  skin: string;                  // character skin id (src/game/skins.json, or 'classic')
}

export const DEFAULT_SETTINGS: Settings = {
  preset: null, assist: 0.2, support: DEFAULT_SUPPORT, strength: 1, speed: 1, toughness: 1, juking: 0.5, hitPower: 1.5, traction: 1.2, gains: {}, mute: false, effortShading: true,
  slowMo: true, autoCamera: false, sprintToggle: false, sinkToggle: false, camera: 'chase', bindings: {}, overlay: false, skin: 'voxel',
};

/** Difficulty presets: each axis moves on its own (AI toughness, AI juking, the player's strength and speed). */
export const DIFFICULTY_PRESETS = {
  easy: { toughness: 0.6, juking: 0, strength: 1.2, speed: 1.1 },
  normal: { toughness: 1, juking: 0.5, strength: 1, speed: 1 },
  hard: { toughness: 1.6, juking: 1, strength: 1, speed: 1 },
};
export type DifficultyName = keyof typeof DIFFICULTY_PRESETS | 'custom';
/** The preset the settings match, or 'custom'. */
export const difficultyOf = (s: Settings): DifficultyName =>
  (Object.keys(DIFFICULTY_PRESETS) as (keyof typeof DIFFICULTY_PRESETS)[]).find((k) => Object.entries(DIFFICULTY_PRESETS[k]).every(([f, v]) => s[f as keyof typeof DIFFICULTY_PRESETS.easy] === v)) ?? 'custom';

const KEY = 'zane-stick-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw); return { ...DEFAULT_SETTINGS, ...s, support: { ...DEFAULT_SUPPORT, ...s.support } }; }
  } catch { /* storage unavailable: use defaults */ }
  return { ...DEFAULT_SETTINGS, support: { ...DEFAULT_SUPPORT } };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
