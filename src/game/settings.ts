// Player settings, remembered per browser. Storage can be unavailable (school-managed profiles, private
// windows), so every read and write is guarded and the defaults always work.
import { DEFAULT_SUPPORT, type SupportSettings } from '../sim/anim/types';
import type { PresetName } from './presets';

export interface Settings {
  preset: PresetName | null;     // null = not chosen yet (run the first-launch benchmark)
  assist: number;                // balance assist 0..1 (hand controller without support)
  support: SupportSettings;      // active-ragdoll support (tuning)
  strength: number;              // muscle strength scale (tuning)
  speed: number;                 // max joint speed scale (tuning)
  traction: number;              // cleat–turf friction (tuning)
  gains: Record<string, number>; // controller gain overrides (tuning)
  mute: boolean;
  effortShading: boolean;
  slowMo: boolean;
  autoCamera: boolean;            // camera follows the athlete (no mouse look needed)
  camera: 'chase' | 'helmet';
  bindings: Record<string, string[]>; // the player's keyboard / mouse rebinds, per action, over bindings.json
  overlay: boolean;
  skin: string;                  // character skin id (src/game/skins.json, or 'classic')
}

export const DEFAULT_SETTINGS: Settings = {
  preset: null, assist: 0.2, support: DEFAULT_SUPPORT, strength: 1, speed: 1, traction: 1.2, gains: {}, mute: false, effortShading: true,
  slowMo: true, autoCamera: false, camera: 'chase', bindings: {}, overlay: false, skin: 'voxel',
};

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
