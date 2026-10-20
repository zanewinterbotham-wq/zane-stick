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

/** A World stand-in: athletes in pairs (0-1, 2-3, …) a metre apart along z, pair k closing at `v[k]` m/s; contacts set
 *  per step. */
function fakeWorld(...v: number[]) {
  const st = (z: number, vz: number) => ({ state: { com: [0, 1, z], comVel: [0, 0, vz] } });
  return { dt: 1 / 240, hits: [] as HitEvent[], scene: { athletes: v.flatMap((x) => [st(0, x / 2), st(1, -x / 2)]) } };
}
const ev = (segA: string, segB: string, force: number, speed: number, a = 0, b = 1): HitEvent => ({ a, segA, b, segB, force, pos: [0, 0, 0], speed });

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
    expect([m.big!.a, m.big!.b]).toEqual([0, 1]);
  });
  it("a collision's closing speed and pair are its strongest contact's, not athletes 0 and 1", () => {
    // athletes 0 and 1 run at each other at 12 m/s without touching; 2 and 3 collide at 3 m/s, 4 and 5 at 10 m/s
    const slow = fakeWorld(12, 3), ms = new HitMeter();
    for (let i = 0; i < 12; i++) { slow.hits = [ev('thorax', 'thorax', 20000, 3, 2, 3)]; expect(ms.step(slow as unknown as World).bigNow).toBeNull(); }
    expect(ms.best).toMatchObject({ a: 2, b: 3 });
    expect(ms.best!.closing).toBeCloseTo(3, 6);
    const w = fakeWorld(0, 3, 10), m = new HitMeter();
    for (let i = 0; i < 12; i++) { w.hits = [ev('handL', 'thorax', 500, 3, 2, 3), ev('thorax', 'thorax', 20000, 10, 5, 4)]; m.step(w as unknown as World); }
    expect(m.big).toMatchObject({ a: 5, b: 4 });
    expect(m.big!.closing).toBeCloseTo(10, 6);
  });
});
