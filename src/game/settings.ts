// Player settings, remembered per browser. Storage can be unavailable (school-managed profiles, private
// windows), so every read and write is guarded and the defaults always work.
import { DEFAULT_SUPPORT, type SupportSettings } from '../sim/anim/types';
import type { PresetName } from './presets';
import skins from './skins.json';
import stadiums from './stadiums.json';

export interface Settings {
  preset: PresetName | null;     // null = not chosen yet (run the first-launch benchmark)
  assist: number;                // balance assist 0..1 (hand controller without support)
  support: SupportSettings;      // active-ragdoll support (tuning)
  version?: number;               // stored layout (see VERSION)
  strength: number;              // the player's muscle strength scale (difficulty)
  speed: number;                 // the player's max joint speed scale (difficulty)
  toughness: number;             // AI toughness: the bot's support thresholds × (difficulty; 1 = the player's)
  juking: number;                // AI juking skill 0..1 (difficulty)
  tackling: number;              // AI tackling skill 0..1 (difficulty): reads your jukes, pursuit angles
  boneStrength: number;          // the player's break tolerances × (1 = measured; lower breaks more easily)
  aiBoneStrength: number;        // the bots' break tolerances ×
  hitPower: number;              // arcade hit power, 1 = pure physics
  steerAssist: number;           // 0..1: the player's run turns this far toward the ball carrier or a loose ball
  traction: number;              // cleat–turf friction (tuning)
  gains: Record<string, number>; // controller gain overrides (tuning)
  mute: boolean;
  effortShading: boolean;
  slowMo: boolean;
  autoCamera: boolean;            // camera follows the athlete (no mouse look needed)
  sprintToggle: boolean;          // sprint key toggles instead of hold
  camera: 'chase' | 'helmet';
  bindings: Record<string, string[]>; // the player's keyboard / mouse rebinds, per action, over bindings.json
  overlay: boolean;
  skin: string;                  // character skin id (src/game/skins.json, or 'classic')
  stadium: string;               // stadium id (src/game/stadiums.json, or 'field' for the Open Field)
  goreLevel: number;             // injury effects 0..4: none (stars) .. very high (render/effects.ts GORE_LEVELS)
  mode?: string;                 // last game mode played (src/sim/modes/registry.ts id)
  modeOptions?: Record<string, Record<string, unknown>>; // each mode's options as last set in the mode menu
}

/** Owner's tuned baseline for Normal (2026-10-18): the player's strength and speed at 1x, and the carry
 *  acceleration. The difficulty sliders are multipliers on these. */
export const PLAYER_BASE = { strength: 1.5, speed: 1.29 };
export const GAME_SUPPORT = { ...DEFAULT_SUPPORT, carryAccel: 10.5 };
/** Stored settings layout; 2 = strength/speed are multipliers on PLAYER_BASE; 3 = gore levels, owner's new default
 *  skin and stadium; 4 = no sink control (lowering the pads sinks the hips). */
const VERSION = 4;

export const DEFAULT_SETTINGS: Settings = {
  version: VERSION, preset: null, assist: 0.2, support: GAME_SUPPORT, strength: 1, speed: 1, toughness: 1, juking: 0.5, tackling: 0.5, boneStrength: 1, aiBoneStrength: 1, hitPower: 1.5, steerAssist: 0.3, traction: 1.2, gains: {}, mute: false, effortShading: true,
  slowMo: true, autoCamera: false, sprintToggle: false, camera: 'chase', bindings: {}, overlay: false, skin: skins[0]?.id ?? 'classic', goreLevel: 1, stadium: stadiums[0]?.id ?? 'field', // the owner's picks are first in the lists
};

/** Difficulty presets: each axis moves on its own (AI toughness, AI juking, the player's strength and speed). */
export const DIFFICULTY_PRESETS = {
  easy: { toughness: 0.6, juking: 0, tackling: 0.2, strength: 1.2, speed: 1.1 },
  normal: { toughness: 1, juking: 0.5, tackling: 0.5, strength: 1, speed: 1 },
  hard: { toughness: 1.6, juking: 1, tackling: 1, strength: 1, speed: 1 },
};
export type DifficultyName = keyof typeof DIFFICULTY_PRESETS | 'custom';
/** The preset the settings match, or 'custom'. */
export const difficultyOf = (s: Settings): DifficultyName =>
  (Object.keys(DIFFICULTY_PRESETS) as (keyof typeof DIFFICULTY_PRESETS)[]).find((k) => Object.entries(DIFFICULTY_PRESETS[k]).every(([f, v]) => s[f as keyof typeof DIFFICULTY_PRESETS.easy] === v)) ?? 'custom';

const KEY = 'zane-stick-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // version 1 stored absolute strength/speed; they are multipliers on the owner's baseline now
      if ((s.version ?? 1) < 2) {
        if (typeof s.strength === 'number') s.strength /= PLAYER_BASE.strength;
        if (typeof s.speed === 'number') s.speed /= PLAYER_BASE.speed;
        if (s.support?.carryAccel === DEFAULT_SUPPORT.carryAccel) s.support.carryAccel = GAME_SUPPORT.carryAccel;
      }
      if ((s.version ?? 1) < 3) {
        // the owner picked new defaults: start once from them; Gore off maps to the no-blood level
        delete s.skin; delete s.stadium;
        if (s.gore === false) s.goreLevel = 0;
        delete s.gore;
      }
      if ((s.version ?? 1) < 4) { delete s.sinkToggle; delete s.bindings?.sink; } // the sink control is gone
      return { ...DEFAULT_SETTINGS, ...s, version: VERSION, support: { ...GAME_SUPPORT, ...s.support } };
    }
  } catch { /* storage unavailable: use defaults */ }
  return { ...DEFAULT_SETTINGS, support: { ...GAME_SUPPORT } };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
