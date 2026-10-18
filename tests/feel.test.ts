import { describe, expect, it } from 'vitest';
import { BIG_HIT_J, BIG_HIT_V, hitFeel, hitKind, hitLoudness, HitMeter, isBigHit } from '../src/game/feel';
import type { HitEvent, World } from '../src/sim/world';

describe('hit classification', () => {
  it('names the surfaces that met', () => {
    expect(hitKind('head', 'head', 8)).toBe('helmet');
    expect(hitKind('head', 'thorax', 8)).toBe('helmetPads');
    expect(hitKind('thighL', 'head', 8)).toBe('helmetPads');
    expect(hitKind('thorax', 'thorax', 8)).toBe('pads');
    expect(hitKind('thorax', 'upperArmR', 8)).toBe('body');
    expect(hitKind('shankL', 'pelvis', 1)).toBe('body');
  });
  it('a slow hand is a grab, a fast one a strike', () => {
    expect(hitKind('handL', 'thorax', 1)).toBe('grab');
    expect(hitKind('lumbar', 'handR', 2.9)).toBe('grab');
    expect(hitKind('handL', 'thorax', 6)).toBe('body');
    expect(hitKind('handR', 'head', 6)).toBe('helmetPads');
  });
});

describe('loudness', () => {
  it('grows with closing speed and force, within 0..1', () => {
    expect(hitLoudness(0, 0)).toBe(0);
    expect(hitLoudness(1, 500)).toBeLessThan(hitLoudness(6, 500));
    expect(hitLoudness(4, 1000)).toBeLessThan(hitLoudness(4, 20000));
    expect(hitLoudness(30, 1e6)).toBe(1);
    expect(hitLoudness(0.5, 400)).toBeLessThan(0.1); // a light touch is quiet
  });
});

describe('big hits', () => {
  it('need both impulse and closing speed', () => {
    expect(isBigHit(BIG_HIT_J, BIG_HIT_V)).toBe(true);
    expect(isBigHit(BIG_HIT_J - 1, 12)).toBe(false);
    expect(isBigHit(900, BIG_HIT_V - 0.1)).toBe(false);
  });
  it('hit-stop is 40-80 ms and only on big hits', () => {
    expect(hitFeel(BIG_HIT_J - 1, 12).stopMs).toBe(0);
    expect(hitFeel(BIG_HIT_J - 1, 12).slowMo).toBe(false);
    for (const [J, v] of [[BIG_HIT_J, BIG_HIT_V], [BIG_HIT_J, 12], [3000, 15]]) {
      const s = hitFeel(J, v).stopMs;
      expect(s).toBeGreaterThanOrEqual(40);
      expect(s).toBeLessThanOrEqual(80);
    }
  });
});

/** A two-athlete World stand-in: closing at `v` m/s along z, contacts set per step. */
function fakeWorld(v: number) {
  const st = (z: number, vz: number) => ({ state: { com: [0, 1, z], comVel: [0, 0, vz] } });
  return { dt: 1 / 240, hits: [] as HitEvent[], scene: { athletes: [st(0, v / 2), st(1, -v / 2)] } };
}
const ev = (segA: string, segB: string, force: number, speed: number): HitEvent => ({ a: 0, segA, b: 1, segB, force, pos: [0, 0, 0], speed });

describe('HitMeter', () => {
  it('a long contact sounds once, and a light touch is never big', () => {
    const w = fakeWorld(2), m = new HitMeter();
    let sounds = 0;
    for (let i = 0; i < 240; i++) {
      w.hits = [ev('handL', 'thorax', 400, 0.5)];
      const r = m.step(w as unknown as World);
      sounds += r.sounds.length;
      expect(r.bigNow).toBeNull();
    }
    expect(sounds).toBe(1);
    expect(m.big).toBeNull();
    expect(m.best!.impulse).toBeCloseTo(400 * 0.03, 0);
  });
  it('a hard collision fires one big hit with its closing speed and impulse', () => {
    const w = fakeWorld(10), m = new HitMeter();
    let bigs = 0;
    for (let i = 0; i < 48; i++) {
      w.hits = i < 12 ? [ev('thorax', 'thorax', 20000, 9), ev('head', 'head', 5000, 9), ev('forearmL', 'thighR', 800, 9)] : [];
      const r = m.step(w as unknown as World);
      if (i === 0) expect(r.sounds.map((s) => s.kind)).toEqual(['pads', 'helmet']); // two loudest of three
      if (r.bigNow) bigs++;
    }
    expect(bigs).toBe(1);
    expect(m.big!.closing).toBeCloseTo(10, 6);
    expect(m.big!.impulse).toBeCloseTo(25800 * 7 / 240, 3); // 30 ms = 7 steps at 240 Hz
  });
});
