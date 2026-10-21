// Player settings, remembered per browser. Storage can be unavailable (school-managed profiles, private
// windows), so every read and write is guarded and the defaults always work.
import { catchTuning, type CatchTuning } from '../sim/modes/catching';
import { fumbleTuning, type FumbleTuning } from '../sim/fumble';
import { qbTuning, type QbTuning } from '../sim/brains/football/qbTuning';
import { jumpTuning, type JumpTuning } from '../sim/anim/jump';
import { DEFAULT_SUPPORT, type SupportSettings } from '../sim/anim/types';
import { carrierSkill } from '../sim/brains/carrier';
import { tacklerSkill } from '../sim/brains/tackler';
import { DEFAULT_OPEN_FIELD } from '../sim/drills/openField';
import type { PlayConfig } from '../sim/modes/types';
import { cleanPerf, PRESETS, type PerfOverrides, type Preset, type PresetName } from './presets';
import skins from './skins.json';
import stadiums from './stadiums.json';

export interface Settings {
  preset: PresetName | null;     // null = not chosen yet (run the first-launch benchmark)
  perf: PerfOverrides;           // the Graphics tab's Advanced overrides on top of the preset ({} = the preset as is)
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
  catching: Partial<CatchTuning>; // catch tuning overrides (sim/modes/catching.ts); {} = the defaults
  jump: Partial<JumpTuning>;     // jump tuning knobs over the defaults (Advanced: Jump; {} = the defaults)
  fumble: Partial<FumbleTuning>; // fumble tuning over the defaults (Advanced: Fumbles; {} = the defaults)
  qb: Partial<QbTuning>;         // bot QB tuning over the defaults (Advanced: Bot QB; {} = the defaults)
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
  netName?: string;              // multiplayer display name (the room server trims it to 24 characters)
}

/** Owner's tuned baseline for Normal (2026-10-18, retuned 2026-10-20 from the Tuning export): the player's strength
 *  and speed at 1x, and the carry acceleration. The difficulty sliders are multipliers on these. */
export const PLAYER_BASE = { strength: 1.785, speed: 0.9675 };
/** The bone strength the Player / AI bone strength sliders multiply (owner's export 2026-10-20). */
export const BONE_BASE = { player: 1.5, ai: 0.9 };
/** The game's tuning groups at the owner's values (export 2026-10-20); the sim's own defaults stay pure physics and
 *  the test baseline. A player's stored knobs go on top of these. */
export const GAME_TUNING = {
  jump: { height: 1.35, runHeight: 1.65, dip: 0.22, load: 0.1, push: 0.1, charge: 0.25, chargeMin: 0.75, carry: 0.95, air: 1.5, soft: 0.75, recover: 0.3, cooldown: 0.2, buffer: 0.25, arms: 1.3, tuck: 1.15 },
  qb: { skill: 1, look: 0.02, lookK: 1.2, aim: 0.15, aimPerM: 0.025, nerves: 0.6, misread: 0.2, open: 0.2 },
  catching: { reach: 0.8, twoHands: 1, oneHand: 0.8, body: 0.9, edge: 0.8, hard: 0.85, moving: 0.95, air: 0.92, contact: 0.65, blind: 0.9 },
  fumble: { hold: 2, window: 0.05 },
} satisfies { jump: JumpTuning; qb: QbTuning; catching: CatchTuning; fumble: FumbleTuning };
export const GAME_SUPPORT = { ...DEFAULT_SUPPORT, carryAccel: 10.5 };
/** Stored settings layout; 2 = strength/speed are multipliers on PLAYER_BASE; 3 = gore levels, owner's new default
 *  skin and stadium; 4 = no sink control (lowering the pads sinks the hips); 5 = thrust on Q, Space jumps; 6 = the
 *  quality ladder (Potato … Ultra; the stored 'minimum' and 'high' keep their meaning) and its Advanced overrides; 7 = the
 *  QB throw controls (F, R, G, V) and the throw scheme; 8 = jump tuning (Advanced: Jump; absent = the defaults); 9 = the
 *  owner's retuned defaults (new PLAYER_BASE / BONE_BASE, steer assist 1, GAME_TUNING). */
const VERSION = 9;

export const DEFAULT_SETTINGS: Settings = {
  version: VERSION, preset: null, perf: {}, assist: 0.2, support: GAME_SUPPORT, strength: 1, speed: 1, toughness: 1, juking: 0.5, tackling: 0.5, boneStrength: 1, aiBoneStrength: 1, hitPower: 1.5, ...structuredClone(GAME_TUNING), steerAssist: 1, traction: 1.2, gains: {}, mute: false, effortShading: true,
  slowMo: true, autoCamera: false, sprintToggle: false, camera: 'chase', bindings: {}, overlay: false, skin: skins[0]?.id ?? 'classic', goreLevel: 1, stadium: stadiums[0]?.id ?? 'field' // the owner's picks are first in the lists
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

/** The World and bodies from a player's settings and quality level: every rep's PlayConfig (a multiplayer host's goes
 *  to every guest), and what the benches and tests use as "the game's settings". */
export function gamePlayConfig(s: Settings, p: Preset): PlayConfig {
  return {
    physics: p.physics, assist: s.assist, seed: 1, difficulty: carrierSkill(s.juking), defense: tacklerSkill(s.tackling), toughness: s.toughness, hitPower: s.hitPower, catching: s.catching, jump: s.jump, qb: s.qb, fumble: s.fumble, boneStrength: BONE_BASE.player * s.boneStrength, aiBoneStrength: BONE_BASE.ai * s.aiBoneStrength, carrierGait: DEFAULT_OPEN_FIELD.carrierGait, activeBots: p.activeBots,
    human: { ...DEFAULT_OPEN_FIELD.human, strength: PLAYER_BASE.strength * s.strength, speed: PLAYER_BASE.speed * s.speed }, bot: DEFAULT_OPEN_FIELD.carrier, traction: s.traction, gains: s.gains,
    support: { ...GAME_SUPPORT, ...s.support },
  };
}

const KEY = 'zane-stick-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // version 1 stored absolute strength/speed; they are multipliers on the owner's baseline now
      if ((s.version ?? 1) < 2) {
        if (typeof s.strength === 'number') s.strength /= 1.5; // the version-2 base (version 9 rescales it again)
        if (typeof s.speed === 'number') s.speed /= 1.29;
        if (s.support?.carryAccel === DEFAULT_SUPPORT.carryAccel) s.support.carryAccel = GAME_SUPPORT.carryAccel;
      }
      if ((s.version ?? 1) < 3) {
        // the owner picked new defaults: start once from them; Gore off maps to the no-blood level
        delete s.skin; delete s.stadium;
        if (s.gore === false) s.goreLevel = 0;
        delete s.gore;
      }
      // version 9: new bases. A value still at the old default moves to the new default; a moved one keeps what it gave
      if ((s.version ?? 1) < 9) {
        const keep = (k: string, old: number, now: number) => { if (typeof s[k] === 'number' && s[k] !== 1) s[k] = Math.round((s[k] * old / now) * 1e4) / 1e4; };
        keep('strength', 1.5, PLAYER_BASE.strength); keep('speed', 1.29, PLAYER_BASE.speed);
        keep('boneStrength', 1, BONE_BASE.player); keep('aiBoneStrength', 1, BONE_BASE.ai);
        if (s.steerAssist === 0.3) s.steerAssist = 1;
      }
      if ((s.version ?? 1) < 4) { delete s.sinkToggle; delete s.bindings?.sink; } // the sink control is gone
      // version 5: thrust moved to Q and Space jumps; a saved rebind keeps its key, and the new default it clashes
      // with gives that key up (as a rebind does), so one key never does two things
      if ((s.version ?? 1) < 5 && s.bindings) migrateJumpKeys(s.bindings);
      // version 7: the throw controls' new default keys give way to a saved rebind that holds them
      if ((s.version ?? 1) < 7 && s.bindings) yieldNewKeys(s.bindings, [['throw', 'KeyF']]);
      // the throw-scheme choice and its keys are gone: the placement reticle is the only QB control
      delete s.throwScheme; if (s.bindings) { delete s.bindings.lob; delete s.bindings.target; delete s.bindings.scheme; }
      // version 6: more levels; an unknown one (an edited or newer file) is chosen again by the benchmark
      if (s.preset != null && !(s.preset in PRESETS)) s.preset = null;
      s.perf = cleanPerf(s.perf);
      // the tuning groups (catching, bot QB, version 8: jump): only valid knobs are kept, clamped; the rest are the defaults
      // (the game's values, GAME_TUNING, under them)
      s.catching = { ...GAME_TUNING.catching, ...overrides(s.catching, catchTuning(s.catching)) };
      s.qb = { ...GAME_TUNING.qb, ...overrides(s.qb, qbTuning(s.qb)) };
      s.fumble = { ...GAME_TUNING.fumble, ...overrides(s.fumble, fumbleTuning(s.fumble)) };
      const jump = { ...GAME_TUNING.jump, ...overrides(s.jump, jumpTuning(s.jump)) };
      // (a copy of the defaults: a field the file lacks must not share, and later mutate, DEFAULT_SETTINGS')
      return { ...structuredClone(DEFAULT_SETTINGS), ...s, version: VERSION, support: { ...GAME_SUPPORT, ...s.support }, jump };
    }
  } catch { /* storage unavailable: use defaults */ }
  return structuredClone(DEFAULT_SETTINGS);
}

/** A tuning group's stored overrides: the known knobs saved as finite numbers, at their validated values (`tuned`). */
function overrides<T extends object>(raw: unknown, tuned: T): Partial<T> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(tuned).filter(([k]) => Number.isFinite((raw as Record<string, unknown>)[k]))) as Partial<T>;
}

/** v4 → v5 keyboard rebinds: Space leaves a saved thrust rebind (dropped if nothing is left), and a key another saved
 *  rebind holds leaves the new default that also has it (thrust Q, jump Space). */
function migrateJumpKeys(b: Record<string, string[]>) {
  if (Array.isArray(b.thrust)) { b.thrust = b.thrust.filter((k) => k !== 'Space'); if (!b.thrust.length) delete b.thrust; }
  yieldNewKeys(b, [['thrust', 'KeyQ'], ['jump', 'Space']]);
}

/** A new default key another saved rebind already holds is left off that new action (as a rebind takes it). */
function yieldNewKeys(b: Record<string, string[]>, defaults: [string, string][]) {
  for (const [action, key] of defaults) {
    if (b[action]) continue;
    if (Object.entries(b).some(([a, v]) => a !== action && Array.isArray(v) && v.includes(key))) b[action] = [];
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
