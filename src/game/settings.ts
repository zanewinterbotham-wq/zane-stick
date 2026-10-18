// Player settings, remembered per browser. Storage can be unavailable (school-managed profiles, private
// windows), so every read and write is guarded and the defaults always work.
import type { PresetName } from './presets';

export interface Settings {
  preset: PresetName | null;     // null = not chosen yet (run the first-launch benchmark)
  assist: number;                // balance assist 0..1
  strength: number;              // muscle strength scale (tuning)
  traction: number;              // cleat–turf friction (tuning)
  gains: Record<string, number>; // controller gain overrides (tuning)
  mute: boolean;
  effortShading: boolean;
  slowMo: boolean;
  contactModeHold: boolean;
  camera: 'chase' | 'helmet';
  overlay: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  preset: null, assist: 0.2, strength: 1, traction: 1.2, gains: {}, mute: false, effortShading: true,
  slowMo: true, contactModeHold: false, camera: 'chase', overlay: false,
};

const KEY = 'zane-stick-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* storage unavailable: use defaults */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
