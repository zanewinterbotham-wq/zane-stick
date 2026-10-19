// Stored settings from before the owner's baseline (absolute strength/speed) migrate to multipliers.
import { beforeEach, expect, it } from 'vitest';
import { loadSettings, saveSettings, PLAYER_BASE } from '../src/game/settings';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem'> }).localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
});

it('old absolute values become 1x of the owner baseline, and saved v2 settings stay put', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ strength: PLAYER_BASE.strength, speed: PLAYER_BASE.speed, support: { carryAccel: 8 } }));
  const s = loadSettings();
  expect(s.strength).toBeCloseTo(1); expect(s.speed).toBeCloseTo(1); expect(s.support.carryAccel).toBe(10.5);
  s.strength = 1.2; saveSettings(s);
  expect(loadSettings().strength).toBeCloseTo(1.2);
});

it('fresh settings are 1x with the owner carry acceleration', () => {
  const s = loadSettings();
  expect([s.strength, s.speed, s.support.carryAccel]).toEqual([1, 1, 10.5]);
  saveSettings(s); expect(loadSettings().strength).toBe(1);
});

it('version 3: the owner picks become the default skin and stadium once, and Gore off maps to the no-blood level', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 2, skin: 'voxel', stadium: 'college', gore: false }));
  const s = loadSettings();
  expect([s.skin, s.stadium, s.goreLevel]).toEqual(['rubberhose', 'pro', 0]);
  s.skin = 'clay'; saveSettings(s);
  expect(loadSettings().skin).toBe('clay'); // a choice made after the upgrade sticks
});

it('version 4: the sink toggle and sink rebinds are dropped; multipliers saved by v3 are not scaled again', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 3, strength: 1.2, sinkToggle: true, bindings: { sink: ['KeyX'], dive: ['KeyQ'] } }));
  const s = loadSettings() as unknown as Record<string, unknown>;
  // (and v5: dive kept Q, so the new thrust default gives it up)
  expect([s.strength, 'sinkToggle' in s, s.bindings]).toEqual([1.2, false, { dive: ['KeyQ'], thrust: [] }]);
});

it('version 5: Space leaves a saved thrust rebind for the new jump, and a key another rebind holds leaves the new default', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 4, bindings: { thrust: ['Space', 'Mouse1'], dive: ['KeyQ'] } }));
  expect(loadSettings().bindings).toEqual({ thrust: ['Mouse1'], dive: ['KeyQ'] });
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 4, bindings: { thrust: ['Space'] } }));
  expect(loadSettings().bindings).toEqual({});   // thrust falls back to its new default, Q
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 4, bindings: { dive: ['KeyQ'], armL: ['Space'], thrust: [] } }));
  expect(loadSettings().bindings).toEqual({ dive: ['KeyQ'], armL: ['Space'], thrust: [], jump: [] });
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 5, bindings: { thrust: ['Space'] } }));
  expect(loadSettings().bindings).toEqual({ thrust: ['Space'] });   // chosen after the upgrade: kept
});

it('version 6: the stored Low and High keep their meaning, an unknown level is chosen again, overrides are validated', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 5, preset: 'high' }));
  expect([loadSettings().preset, loadSettings().perf]).toEqual(['high', {}]);
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 6, preset: 'turbo', perf: { hz: 200, scale: 7, shadows: 'yes', lod: 12, bogus: 1 } }));
  expect([loadSettings().preset, loadSettings().perf]).toEqual([null, { hz: 200, lod: 12 }]);
});

it('version 7: the throw keys give way to saved rebinds that hold them, and an unknown throw scheme is the default', () => {
  store.set('zane-stick-settings-v1', JSON.stringify({ version: 6, bindings: { dive: ['KeyF'], armL: ['KeyV', 'Mouse0'] }, throwScheme: 'bogus' }));
  const s = loadSettings();
  expect([s.bindings, s.throwScheme]).toEqual([{ dive: ['KeyF'], armL: ['KeyV', 'Mouse0'], throw: [], scheme: [] }, 'lock']);
  s.throwScheme = 'flick'; saveSettings(s);
  expect(loadSettings().throwScheme).toBe('flick'); // the choice is remembered
});
