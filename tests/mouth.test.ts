// Mouths (render/mouth.ts): the amplitude envelope, how it opens the mouth, which shape each voice makes, and that
// the driver talks smoothly and relaxes when the sound ends.
import { describe, expect, it } from 'vitest';
import { envelope, MouthDriver, openness, poseAt, SHAPES, shapeOf, syntheticEnvelope, type Voice } from '../src/game/render/mouth';

const voice = (cat: string, env: Float32Array, over: Partial<Voice> = {}): Voice => ({ athlete: 0, cat, env, hz: 60, rate: 1, loud: 1, ...over });
const run = (d: MouthDriver, seconds: number, dt = 1 / 60) => { const hs: number[] = []; for (let t = 0; t < seconds; t += dt) hs.push(d.update(dt).h); return hs; };

describe('voice envelope', () => {
  it('is the RMS in 1/60 s windows, scaled so the loudest is 1', () => {
    const sr = 6000, x = new Float32Array(sr); // one second: silence, then a tone at half the amplitude of the second half
    for (let i = 0; i < sr; i++) x[i] = i < sr / 2 ? 0 : (i < 3 * sr / 4 ? 0.2 : 0.4) * Math.sin(2 * Math.PI * 440 * i / sr);
    const e = envelope(x, sr);
    expect(e.length).toBe(60);
    expect(e[5]).toBe(0);
    expect(Math.max(...e)).toBeCloseTo(1, 9);
    expect(e[35]).toBeCloseTo(0.5, 1);
  });
});

describe('openness and shapes', () => {
  it('a noise gate, then monotonic up to fully open', () => {
    expect(openness(0)).toBe(0);
    expect(openness(0.03)).toBe(0);
    expect(openness(1)).toBe(1);
    let prev = 0;
    for (let e = 0.05; e <= 1; e += 0.05) { expect(openness(e)).toBeGreaterThan(prev); prev = openness(e); }
  });

  it('each voice category makes its own shape; other sounds make none', () => {
    expect(shapeOf('voice_grunt')).toBe('grunt');
    expect(shapeOf('voice_exhale')).toBe('exhale');
    expect(shapeOf('pain_scream')).toBe('scream');
    expect(shapeOf('pain_moan')).toBe('moan');
    expect(shapeOf('hit_pads_pads')).toBeNull();
    expect(shapeOf('ko_thud')).toBeNull();
  });

  it('closed is shut; a grunt opens a little, a scream wide; a moan bares teeth with the corners down; an exhale is a narrow O', () => {
    expect(poseAt('grunt', 0)).toEqual(SHAPES.closed);
    expect(SHAPES.closed.h).toBe(0);
    expect(SHAPES.grunt.h).toBeGreaterThan(0);
    expect(SHAPES.scream.h).toBeGreaterThan(2 * SHAPES.grunt.h);
    expect(SHAPES.moan.teeth).toBeGreaterThan(SHAPES.scream.teeth);
    expect(SHAPES.moan.curve).toBeLessThan(0);
    expect(SHAPES.moan.w).toBeGreaterThan(SHAPES.scream.w);
    expect(SHAPES.exhale.w).toBeLessThan(0.6);
    expect(SHAPES.exhale.h / SHAPES.exhale.w).toBeGreaterThan(1);
    expect(poseAt('scream', 0.5).h).toBeCloseTo(SHAPES.scream.h / 2, 9);
  });
});

describe('mouth driver', () => {
  it('follows the sound: opens with the envelope, relaxes to closed when it ends, no flicker between frames', () => {
    const d = new MouthDriver();
    expect(run(d, 0.5).every((h) => h === 0)).toBe(true);
    // a syllable of speech: loud for 0.3 s, quiet 0.2 s, loud 0.3 s
    d.say(voice('voice_grunt', Float32Array.from({ length: 48 }, (_, i) => (i < 18 || i >= 30 ? 1 : 0.05))));
    const hs = run(d, 1.5);
    expect(Math.max(...hs)).toBeGreaterThan(0.8 * SHAPES.grunt.h);
    const dip = hs.slice(18, 40);
    expect(Math.max(...hs.slice(8, 18)) - Math.min(...dip)).toBeGreaterThan(0.05); // the pause shows
    for (let i = 1; i < hs.length; i++) expect(Math.abs(hs[i] - hs[i - 1])).toBeLessThan(0.5 * SHAPES.grunt.h); // smoothed
    expect(hs[hs.length - 1]).toBeLessThan(0.01);
  });

  it('plays at the sound\'s playback rate', () => {
    const slow = new MouthDriver(), fast = new MouthDriver();
    const env = Float32Array.from({ length: 60 }, (_, i) => (i < 30 ? 1 : 0));
    slow.say(voice('voice_grunt', env, { rate: 0.5 })); fast.say(voice('voice_grunt', env, { rate: 2 }));
    expect(run(slow, 0.8).filter((h) => h > 0.05).length).toBeGreaterThan(run(fast, 0.8).filter((h) => h > 0.05).length);
  });

  it('a scream is wide; a pain sound leaves a grimace that fades; a grunt does not', () => {
    const scream = new MouthDriver(), grunt = new MouthDriver();
    scream.say(voice('pain_scream', syntheticEnvelope('pain_scream'))); grunt.say(voice('voice_grunt', syntheticEnvelope('voice_grunt')));
    const peakS = Math.max(...run(scream, 0.9)), peakG = Math.max(...run(grunt, 0.2));
    expect(peakS).toBeGreaterThan(2 * peakG);
    run(scream, 0.9); // past the end of the 1.4 s scream
    const after = run(scream, 0.1), later = run(scream, 3);
    expect(after[after.length - 1]).toBeGreaterThan(0.05); // still grimacing
    expect(scream.pose.teeth).toBeGreaterThan(0); // the grimace bares teeth
    expect(later[later.length - 1]).toBeLessThan(0.01); // then relaxed
    run(grunt, 1);
    expect(run(grunt, 0.1).every((h) => h < 0.01)).toBe(true);
  });

  it('ignores non-voice sounds and a second copy of the same sound that has just started', () => {
    const d = new MouthDriver();
    d.say(voice('hit_pads_pads', new Float32Array(30).fill(1)));
    expect(Math.max(...run(d, 0.3))).toBe(0);
    d.say(voice('voice_grunt', new Float32Array(60).fill(1)));
    run(d, 0.1);
    d.say(voice('voice_grunt', new Float32Array(60).fill(1)));
    expect(Math.max(...run(d, 1.2))).toBeGreaterThan(0);
    expect(run(d, 0.5).every((h) => h < 0.01)).toBe(true); // no second voice kept it open
  });
});
