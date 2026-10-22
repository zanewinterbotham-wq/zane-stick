// Tuning export / import (tuning-io.ts): export -> import round-trips, absolute values come back as multipliers, junk is rejected.
import { describe, expect, it } from 'vitest';
import { fumbleTuning, FUMBLE_RANGES } from '../src/sim/fumble';
import { jumpTuning, JUMP_RANGES } from '../src/sim/anim/jump';
import { DEFAULT_GAINS } from '../src/sim/control/hand';
import { DEFAULT_SETTINGS, PLAYER_BASE } from '../src/game/settings';
import { applyTuningJson, exportPart, exportTuning } from '../src/game/tuning-io';

const groups = [{ key: 'jump', ranges: JUMP_RANGES, tune: jumpTuning }, { key: 'fumble', ranges: FUMBLE_RANGES, tune: fumbleTuning }];
const fresh = () => structuredClone(DEFAULT_SETTINGS);

describe('tuning import', () => {
  it('round-trips the whole export', () => {
    const a = fresh();
    Object.assign(a, { speed: 1.2, strength: 0.8, boneStrength: 2, aiBoneStrength: 0.5, steerAssist: 0.3, assist: 0.6, traction: 1.4, gains: { torsoKp: 77 }, fumble: { hold: 3 }, jump: { height: 1.1 } });
    a.support = { ...a.support, strength: 0.4, bigHit: 123 };
    const json = JSON.stringify(exportTuning(a, groups));
    const b = fresh();
    expect(applyTuningJson(b, json, groups)).toBeNull();
    expect(exportTuning(b, groups)).toEqual(exportTuning(a, groups));
    expect(b.speed).toBeCloseTo(1.2, 9); // absolute speed back to the multiplier
    expect(b.gains.torsoKp).toBe(77);
    expect(b.gains.footK).toBe(DEFAULT_GAINS.footK);
  });
  it('imports one category from its own export, keeping only known knobs', () => {
    const a = fresh();
    expect(applyTuningJson(a, JSON.stringify({ hold: 4, junk: 1, window: 'x' }), groups, 'fumble')).toBeNull();
    expect(a.fumble).toEqual(fumbleTuning({ hold: 4 }));
    const p = fresh();
    expect(applyTuningJson(p, JSON.stringify({ speed: PLAYER_BASE.speed * 1.1, support: { strength: 0 } }), groups, 'player')).toBeNull();
    expect(p.speed).toBeCloseTo(1.1, 9);
    expect(p.support).toEqual(DEFAULT_SETTINGS.support); // the player part leaves support alone
    const x = fresh();
    applyTuningJson(x, JSON.stringify(exportPart(p, groups, 'player')), groups, 'player');
    expect(x.speed).toBeCloseTo(1.1, 9);
  });
  it('rejects junk and changes nothing', () => {
    for (const j of ['', 'nope', '[1]', '3', 'null', '{}', '{"jump":{"bogus":1}}', '{"speed":-1}', '{"speed":"fast"}']) {
      const s = fresh();
      expect(applyTuningJson(s, j, groups), j).toEqual(expect.any(String));
      expect(s).toEqual(DEFAULT_SETTINGS);
    }
  });
});
