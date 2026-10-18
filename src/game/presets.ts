// Quality presets. Each scales physics precision, body detail and graphics together.
// Phase 1 ships Minimum and High; the rest of the ladder arrives in Phase 4.
import type { PhysicsSettings } from '../sim/world';
import type { RenderQuality } from './render/renderer';

export type PresetName = 'minimum' | 'high';
export interface Preset { name: PresetName; label: string; physics: PhysicsSettings; render: RenderQuality; targetFps: number }

export const PRESETS: Record<PresetName, Preset> = {
  minimum: {
    name: 'minimum', label: 'Minimum',
    physics: { hz: 240, iterations: 20, detail: 'minimum' },
    render: { scale: 0.6, shadows: false, detail: 'low', antialias: false },
    targetFps: 30,
  },
  high: {
    name: 'high', label: 'High',
    physics: { hz: 480, iterations: 40, detail: 'standard' },
    render: { scale: 1, shadows: true, detail: 'high', antialias: true },
    targetFps: 60,
  },
};
