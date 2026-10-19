// Quality presets: a ladder from Potato to Ultra, each scaling physics precision, body detail and graphics together
// (docs/performance.md has what each level changes and what it costs). Ultra and High run today's High physics bit for
// bit; the approximations (solver tolerances, cone, athlete level of detail) live only on the lowest levels. The
// Graphics tab's Advanced section overrides single knobs on top of the chosen level (Settings.perf).
import type { PhysicsSettings } from '../sim/world';
import type { RenderQuality } from './render/renderer';

/** Ids are stored in saved settings: 'minimum' (shown as Low) and 'high' keep their old meaning. */
export type PresetName = 'potato' | 'minimum' | 'medium' | 'high' | 'ultra';
/** activeBots: waiting bots play the wait instead of idling at their spot (PlayConfig.activeBots); worker: the physics
 *  runs in a Worker beside the page (src/game/worker; absent = on the page). */
export interface Preset { name: PresetName; label: string; desc: string; physics: PhysicsSettings; render: RenderQuality; targetFps: number; activeBots: boolean; worker?: boolean }

/** Lowest to highest (the auto chooser walks it down from the top). */
export const PRESET_ORDER: PresetName[] = ['potato', 'minimum', 'medium', 'high', 'ultra'];

const LOW_GFX: RenderQuality = { scale: 0.6, shadows: false, detail: 'low', antialias: false, shadowMap: 1024, pixelCap: 2, effects: 1, faces: Infinity, maxFps: 0 };
const HIGH_GFX: RenderQuality = { scale: 1, shadows: true, detail: 'high', antialias: true, shadowMap: 2048, pixelCap: 2, effects: 1, faces: Infinity, maxFps: 0 };

export const PRESETS: Record<PresetName, Preset> = {
  potato: {
    name: 'potato', label: 'Potato',
    desc: 'For the slowest laptops: the physics on its own core, fewer steps, a simpler friction model and a looser solver, far bots plan every other step, low resolution, 30 fps. Hits feel slightly softer.',
    physics: { hz: 180, iterations: 20, detail: 'minimum', tolerance: 1e-5, cone: 'pyramidal', lod: 12 },
    render: { ...LOW_GFX, scale: 0.5, pixelCap: 1, effects: 0.25, faces: 15, maxFps: 30 },
    targetFps: 30, activeBots: false, worker: true,
  },
  minimum: {
    name: 'minimum', label: 'Low',
    desc: 'School laptops: merged body segments, 240 Hz physics, no shadows; waiting defenders idle at their spot.',
    physics: { hz: 240, iterations: 20, detail: 'minimum' },
    render: { ...LOW_GFX, faces: 30 },
    targetFps: 30, activeBots: false,
  },
  medium: {
    name: 'medium', label: 'Medium',
    desc: 'The full body at 240 Hz (the realism tests\' standard), soft shadows, 60 fps.',
    physics: { hz: 240, iterations: 30, detail: 'standard' },
    render: { ...HIGH_GFX, scale: 0.85, antialias: false, shadowMap: 1024, pixelCap: 1.5 },
    targetFps: 60, activeBots: true,
  },
  high: {
    name: 'high', label: 'High',
    desc: 'The full body at 480 Hz: the most precise hits and footwork, full resolution and shadows.',
    physics: { hz: 480, iterations: 40, detail: 'standard' },
    render: HIGH_GFX,
    targetFps: 60, activeBots: true,
  },
  ultra: {
    name: 'ultra', label: 'Ultra',
    desc: 'High\'s physics exactly, at the screen\'s full pixel density with sharper shadows.',
    physics: { hz: 480, iterations: 40, detail: 'standard' },
    render: { ...HIGH_GFX, shadowMap: 4096, pixelCap: 3 },
    targetFps: 60, activeBots: true,
  },
};

/** Single knobs the Advanced section overrides on top of a level (absent = the level's own). */
export interface PerfOverrides {
  hz?: number; iterations?: number; detail?: PhysicsSettings['detail']; tolerance?: number; cone?: 'elliptic' | 'pyramidal'; lod?: number;
  worker?: boolean; scale?: number; shadows?: boolean; shadowMap?: number; antialias?: boolean; pixelCap?: number; effects?: number; faces?: number; maxFps?: number;
}

type Choice = { value: number | string | boolean; text: string };
/** The Advanced section's knobs (settings-menu.ts draws one row each): every allowed value, so stored overrides are
 *  validated against the same lists. */
export const PERF_KNOBS: { key: keyof PerfOverrides; label: string; desc: string; physics: boolean; choices: Choice[] }[] = [
  { key: 'hz', label: 'Physics rate', desc: 'Steps per second. Fewer is cheaper; hits are softer and less precise below 240.', physics: true,
    choices: [180, 200, 240, 360, 480].map((v) => ({ value: v, text: `${v} Hz` })) },
  { key: 'iterations', label: 'Solver iterations', desc: 'Most contact-solver iterations per step (it usually needs fewer).', physics: true,
    choices: [10, 20, 30, 40].map((v) => ({ value: v, text: String(v) })) },
  { key: 'detail', label: 'Body detail', desc: 'Full: every segment. Merged: trunk, hands, toes and neck fused (same mass and inertia).', physics: true,
    choices: [{ value: 'standard', text: 'Full' }, { value: 'minimum', text: 'Merged' }] },
  { key: 'tolerance', label: 'Solver tolerance', desc: 'When the contact solver stops. Looser is cheaper and a little less exact.', physics: true,
    choices: [{ value: 1e-8, text: 'Exact' }, { value: 1e-6, text: 'Fine' }, { value: 1e-5, text: 'Loose' }] },
  { key: 'cone', label: 'Friction model', desc: 'Elliptic is the true friction cone; Pyramid is cheaper and grips a little differently.', physics: true,
    choices: [{ value: 'elliptic', text: 'Elliptic' }, { value: 'pyramidal', text: 'Pyramid' }] },
  { key: 'lod', label: 'Far bots', desc: 'Bots this far from the ball and every opponent re-plan their movement every other step (their bodies stay fully simulated).', physics: true,
    choices: [{ value: 0, text: 'Full' }, { value: 12, text: '12 m' }, { value: 20, text: '20 m' }] },
  { key: 'worker', label: 'Physics thread', desc: 'Worker: the physics runs on its own core beside the graphics (one frame more input delay; the anatomy view shows no muscle effort). Page: one core does both.', physics: true,
    choices: [{ value: false, text: 'Page' }, { value: true, text: 'Worker' }] },
  { key: 'scale', label: 'Resolution', desc: 'Share of the screen resolution rendered.', physics: false,
    choices: [0.5, 0.6, 0.75, 0.85, 1].map((v) => ({ value: v, text: `${Math.round(v * 100)} %` })) },
  { key: 'pixelCap', label: 'Pixel density cap', desc: 'Highest screen pixel density used (high-DPI screens cost the most).', physics: false,
    choices: [1, 1.5, 2, 3].map((v) => ({ value: v, text: `${v}x` })) },
  { key: 'shadows', label: 'Shadows', desc: 'Athletes cast shadows on the turf.', physics: false, choices: [{ value: false, text: 'Off' }, { value: true, text: 'On' }] },
  { key: 'shadowMap', label: 'Shadow quality', desc: 'Shadow map size.', physics: false, choices: [512, 1024, 2048, 4096].map((v) => ({ value: v, text: String(v) })) },
  { key: 'antialias', label: 'Antialiasing', desc: 'Smooth edges (MSAA).', physics: false, choices: [{ value: false, text: 'Off' }, { value: true, text: 'On' }] },
  { key: 'effects', label: 'Injury effects', desc: 'Share of the particles an injury throws.', physics: false,
    choices: [0, 0.25, 0.5, 1].map((v) => ({ value: v, text: `${Math.round(v * 100)} %` })) },
  { key: 'faces', label: 'Face animation range', desc: 'Faces farther from the camera keep their last expression.', physics: false,
    choices: [{ value: 15, text: '15 m' }, { value: 30, text: '30 m' }, { value: 999, text: 'All' }] },
  { key: 'maxFps', label: 'Frame cap', desc: 'Most frames per second (the physics keeps its own rate).', physics: false,
    choices: [{ value: 0, text: 'Display' }, { value: 60, text: '60' }, { value: 30, text: '30' }] },
];

/** Stored overrides (a trust boundary: localStorage) kept only where they are one of their knob's values. */
export function cleanPerf(o: unknown): PerfOverrides {
  const out: Record<string, unknown> = {};
  if (o && typeof o === 'object') for (const k of PERF_KNOBS) { const v = (o as Record<string, unknown>)[k.key]; if (k.choices.some((c) => c.value === v)) out[k.key] = v; }
  return out as PerfOverrides;
}

/** The level with the player's overrides applied (lod 0 switches that approximation off). */
export function effectivePreset(name: PresetName | null, o: PerfOverrides = {}): Preset {
  const p = PRESETS[name && name in PRESETS ? name : 'minimum'];
  const { hz, iterations, detail, tolerance, cone, lod, worker, ...gfx } = o;
  const physics: PhysicsSettings = { ...p.physics };
  if (hz !== undefined) physics.hz = hz;
  if (iterations !== undefined) physics.iterations = iterations;
  if (detail !== undefined) physics.detail = detail;
  if (tolerance !== undefined) physics.tolerance = tolerance;
  if (cone !== undefined) physics.cone = cone;
  if (lod !== undefined) { if (lod > 0) physics.lod = lod; else delete physics.lod; }
  const render = { ...p.render };
  for (const [k, v] of Object.entries(gfx)) if (v !== undefined) (render as Record<string, unknown>)[k] = v;
  return { ...p, physics, render, worker: worker ?? p.worker ?? false };
}
