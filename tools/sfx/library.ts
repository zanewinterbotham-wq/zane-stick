// Every sound category in the dev library and how each variant is made (synthesis, or CC0 pack material reshaped).
import {
  type Rng, type Sig, SR, ad, ahr, bp, brown, buf, crackle, drive, fade, formants, glottal, hp, layer, loopify,
  lp, mix, modal, osc, peak, pick, pink, resample, reverb, rnd, shape, slice, white,
} from './dsp';

export type Kind = 'oneshot' | 'long' | 'loop';
export interface Ctx { r: Rng; i: number; n: number; v: number; pack: (pack: string, name: string) => Sig }
export interface Made { x: Sig; note: string; source?: string }
export interface Category { id: string; label: string; group: string; event: string; count: number; kind: Kind; level?: number; gen: (c: Ctx) => Made }

const IMPACT = 'kenney/impact-sounds', RPG = 'kenney/rpg-audio', IFACE = 'kenney/interface-sounds', UIA = 'kenney/ui-audio';
const OGA1 = 'opengameart/100-cc0-sfx-rubberduck', OGA2 = 'opengameart/100-cc0-sfx-2-rubberduck';
const RETRO = 'opengameart/512-retro-sfx-juhani-junkala';
const RETRO_HUMAN = 'The Essential Retro Video Game Sound Effects Collection [512 sounds] By Juhani Junkala/Death Screams/Human/';
export const PACKS = [IMPACT, RPG, IFACE, UIA, OGA1, OGA2, RETRO];

const f0 = (x: number) => x.toFixed(0), f2 = (x: number) => x.toFixed(2);
const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`;

// ---- building blocks
/** Sine body thump with a falling pitch (f0 -> f1), soft-clipped. */
const thump = (len: number, a: number, b: number, d: number, k = 1.5) =>
  drive(shape(osc(len, (t) => b + (a - b) * Math.exp(-t / (d * 0.6))), ad(0.0015, d)), k);
/** Noise burst through a filter with an attack/decay envelope. */
const burst = (r: Rng, len: number, f: number, q: number, a: number, d: number, type: 'bp' | 'hp' | 'lp' = 'bp', src = white) => {
  const x = shape(src(len, r), ad(a, d));
  return type === 'bp' ? bp(x, f, q) : type === 'hp' ? hp(x, f, q) : lp(x, f, q);
};
/** Sharp broadband crack (helmet shells, studs). */
const crack = (r: Rng, f: number, d: number) => hp(hp(shape(white(d * 8 + 0.002, r), ad(0.0002, d)), f), f);
/** Grass / cloth crunch: sparse impulses band-passed, under an envelope. */
const crunch = (r: Rng, len: number, rate: number, f: number, q: number, env: (t: number) => number) =>
  bp(shape(crackle(len, r, rate), env), f, q);
/** Inharmonic shell ring (polycarbonate / ABS). */
const ring = (r: Rng, base: number, decay: number, ratios = [1, 1.47, 2.09, 2.56, 3.18, 3.9, 4.7]) =>
  modal(decay * 5, ratios.map((k, j) => ({ f: base * k * (1 + rnd(r, -0.04, 0.04)), a: rnd(r, 0.5, 1) / Math.pow(j + 1, 0.8), d: decay / (1 + j * 0.35) })), r);
/** Pack sample reshaped: pitch/speed ratio, optional band limits, optional cut length. */
function packed(c: Ctx, pack: string, name: string, ratio: number, hpF = 0, lpF = 0, maxLen = 0): Sig {
  let x = resample(c.pack(pack, name), ratio);
  const lim = peak(x) * 0.01;
  x = x.slice(Math.max(0, x.findIndex((s) => Math.abs(s) >= lim) - 20));
  if (maxLen) x = fade(slice(x, 0, maxLen), 0, Math.min(0.03, maxLen / 4));
  if (hpF) hp(x, hpF);
  if (lpF) lp(x, lpF);
  return x;
}
const src = (pack: string, name: string, ratio: number) => `${pack.split('/')[1]} ${name} at x${f2(ratio)}`;

// ---- vowels for non-verbal voices (F1..F3 Hz, adult male; female ~ x1.17)
const VOWELS: Record<string, [number, number, number]> = {
  ah: [730, 1090, 2440], uh: [640, 1190, 2390], eh: [530, 1840, 2480], ee: [390, 1990, 2550],
  oh: [570, 840, 2410], oo: [300, 870, 2240], hn: [280, 1600, 2600],
};
const vowel = (x: Sig, v: [number, number, number], s = 1) =>
  formants(x, [{ f: v[0] * s, bw: 90 * s, g: 1 }, { f: v[1] * s, bw: 110 * s, g: 0.55 }, { f: v[2] * s, bw: 160 * s, g: 0.3 }]);

function claps(r: Rng, len: number, count: number, env: (t: number) => number): Sig {
  let x = buf(len);
  for (let k = 0; k < count; k++) {
    const t = r() * len;
    x = mix(x, bp(shape(white(0.02, r), ad(0.0004, rnd(r, 0.002, 0.005))), rnd(r, 900, 2200), 0.9), rnd(r, 0.3, 1) * env(t), t);
  }
  return x.slice(0, buf(len).length);
}
/** Pea whistle blast: tone with the pea's trill (FM + AM), breath noise. */
function blast(r: Rng, len: number, f: number, rate: number, fm: number, am: number, chirp: number): Sig {
  const freq = (t: number) => f * (1 + fm * Math.sin(2 * Math.PI * rate * t)) * (1 - chirp * Math.exp(-t / 0.04));
  const trill = (t: number) => 1 - am * 0.5 * (1 + Math.sin(2 * Math.PI * rate * t + 1));
  const tone = layer(len, [[osc(len, freq), 1], [osc(len, (t) => 2 * freq(t)), 0.18], [bp(white(len, r), f, 3), 0.35]]);
  return shape(tone, (t) => trill(t) * ahr(0.012, len - 0.05, 0.038)(t));
}
/** Additive voice: the harmonics of f0(t), each weighted by a three-formant resonance envelope at its own frequency
 *  over a −6 dB/octave source tilt, with jitter and shimmer. Thin and clean where a filtered pulse train buzzes; the
 *  formants follow `vow(t)` (F1..F3 Hz, already scaled for the speaker); `tilt` < 1 is a pressed, shouting voice. */
function additive(r: Rng, len: number, f0: (t: number) => number, vow: (t: number) => [number, number, number], o: { jitter?: number; shimmer?: number; bw?: number; top?: number; tilt?: number } = {}): Sig {
  const x = buf(len), jit = o.jitter ?? 0.01, shim = o.shimmer ?? 0.1, bw = o.bw ?? 1, top = o.top ?? 5000, tilt = o.tilt ?? 1;
  let ph = 0, amps: number[] = [], j = 0, jt = 0, s = 1, st = 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    if ((i & 255) === 0) { jt = (r() * 2 - 1) * jit; st = 1 + (r() * 2 - 1) * shim; } // slow random wobble of pitch and level
    j += (jt - j) * 0.002; s += (st - s) * 0.002;
    const f = f0(t) * (1 + j);
    ph += f / SR; ph -= Math.floor(ph);
    if ((i & 31) === 0) {
      const v = vow(t);
      amps = [];
      for (let k = 1; k * f < top; k++) {
        const fk = k * f;
        amps.push((1 / (1 + ((fk - v[0]) / (70 * bw)) ** 2) + 0.5 / (1 + ((fk - v[1]) / (90 * bw)) ** 2) + 0.25 / (1 + ((fk - v[2]) / (130 * bw)) ** 2)) / k ** tilt);
      }
    }
    let y = 0;
    for (let k = 0; k < amps.length; k++) y += amps[k] * Math.sin(2 * Math.PI * (k + 1) * ph);
    x[i] = y * s;
  }
  return x;
}
/** Vowel formants glided from a to b (fraction u(t) 0..1), scaled for vocal tract length / a raised larynx. */
const glide = (a: string, b: string, u: (t: number) => number, sc = 1) => (t: number): [number, number, number] => {
  const k = Math.min(1, Math.max(0, u(t)));
  return [0, 1, 2].map((n) => sc * (VOWELS[a][n] + (VOWELS[b][n] - VOWELS[a][n]) * k)) as [number, number, number];
};
/** Breath noise through a vowel's formants (aspiration over a voice, or a gasp alone). */
const breath = (r: Rng, len: number, v: [number, number, number], env: (t: number) => number) =>
  formants(shape(white(len, r), env), [{ f: v[0], bw: 200, g: 1 }, { f: v[1], bw: 250, g: 0.7 }, { f: v[2], bw: 350, g: 0.4 }]);
const notes = (len: number, freqs: number[], step: number, d: number, wave: 'sine' | 'tri' = 'tri') => {
  let x = buf(len);
  freqs.forEach((f, k) => { x = mix(x, shape(layer(d * 5, [[osc(d * 5, f, wave), 1], [osc(d * 5, f * 2), 0.25]]), ad(0.002, d)), 1, k * step); });
  return x;
};

export const CATEGORIES: Category[] = [
  // ================= Hits
  {
    id: 'hit_helmet_helmet', label: 'Helmet on helmet', group: 'Hits', kind: 'oneshot', count: 12,
    event: 'plays when two helmets collide; louder with harder hits',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 9) {
        const name = `impactPlate_light_00${i - 9}`, k = rnd(r, 0.72, 0.9);
        const x = layer(0.5, [[packed(c, IMPACT, name, k, 300, 7000), 0.8], [crack(r, 2500, 0.003), 0.9], [thump(0.1, 220, 110, 0.025), 0.4]]);
        return { x: drive(x, 1.3), source: IMPACT, note: `${src(IMPACT, name, k)} as the shell ring, with synth crack` };
      }
      const base = 700 * Math.pow(2, v * 1.2), decay = rnd(r, 0.06, 0.18), cf = rnd(r, 2000, 4200), cd = rnd(r, 0.0018, 0.006);
      const x = layer(0.6, [[crack(r, cf, cd), 1], [ring(r, base, decay), 0.45], [thump(0.12, 230, 110, 0.03), 0.5], [burst(r, 0.08, base * 2, 1.5, 0.0005, 0.015), 0.4]]);
      return { x: drive(x, 1.3), note: `crack ${f0(cf)} Hz ${ms(cd)}, shell ring ${f0(base)} Hz ${f2(decay)} s` };
    },
  },
  {
    id: 'hit_helmet_pads', label: 'Helmet on shoulder pads', group: 'Hits', kind: 'oneshot', count: 10,
    event: 'plays when a helmet hits shoulder pads or a chest plate',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 7) {
        const name = `impactPlate_medium_00${i - 7}`, k = rnd(r, 0.6, 0.72);
        const x = layer(0.5, [[packed(c, IMPACT, name, k, 150, 3200), 0.8], [thump(0.15, 170, 70, 0.05), 0.8], [burst(r, 0.1, 900, 0.7, 0.001, 0.02, 'lp'), 0.5]]);
        return { x: drive(x, 1.5), source: IMPACT, note: `${src(IMPACT, name, k)}, low-passed, with synth foam thud` };
      }
      const base = 430 + 380 * v, decay = rnd(r, 0.035, 0.1), cf = rnd(r, 1000, 1700);
      const x = layer(0.45, [[crack(r, cf, rnd(r, 0.002, 0.004)), 0.6], [ring(r, base, decay), 0.35], [thump(0.15, rnd(r, 150, 180), 70, rnd(r, 0.04, 0.065)), 0.9], [burst(r, 0.1, rnd(r, 700, 1100), 0.7, 0.001, 0.02, 'lp'), 0.6]]);
      return { x: drive(x, 1.5), note: `duller crack ${f0(cf)} Hz, short ring ${f0(base)} Hz ${f2(decay)} s, foam thud` };
    },
  },
  {
    id: 'hit_pads_pads', label: 'Pads on pads', group: 'Hits', kind: 'oneshot', count: 12,
    event: 'plays when shoulder pads or chest plates meet; heavy plastic thud',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const k = rnd(r, 0.78, 0.92), name = `impactPunch_heavy_00${i - 8}`, plate = `impactPlate_heavy_00${i - 8}`;
        const x = layer(0.6, [[packed(c, IMPACT, name, k, 60), 1], [packed(c, IMPACT, plate, 0.6, 200, 2500), 0.35], [burst(r, 0.03, 1500, 1.2, 0.0003, 0.008), 0.6]]);
        return { x: drive(x, 1.8), source: IMPACT, note: `${src(IMPACT, name, k)} layered with ${plate} at x0.60 and a synth clack` };
      }
      const base = 170 + 210 * v, d = rnd(r, 0.03, 0.07), cf = rnd(r, 900, 2200);
      const x = layer(0.5, [[ring(r, base, d, [1, 1.62, 2.4, 3.3]), 0.7], [burst(r, 0.04, cf, 1.2, 0.0003, rnd(r, 0.006, 0.012)), 0.8], [thump(0.25, 130, 55, rnd(r, 0.05, 0.09)), 1]]);
      return { x: drive(x, 2), note: `plastic body ${f0(base)} Hz ${f2(d)} s, clack ${f0(cf)} Hz` };
    },
  },
  {
    id: 'hit_body_body', label: 'Body on body', group: 'Hits', kind: 'oneshot', count: 12,
    event: 'plays when torsos, hips or legs collide without pads; dull thump',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const k = rnd(r, 0.8, 0.98), name = i < 11 ? `impactSoft_heavy_00${i - 8}` : 'impactPunch_medium_000';
        const x = layer(0.5, [[packed(c, IMPACT, name, k, 40, 2500), 1], [thump(0.2, 110, 45, 0.1), 0.5]]);
        return { x: drive(x, 1.5), source: IMPACT, note: `${src(IMPACT, name, k)} with synth low thump` };
      }
      const a = 95 + 35 * v, d = rnd(r, 0.09, 0.17);
      const x = layer(0.5, [[thump(0.35, a, rnd(r, 40, 50), d), 1], [burst(r, 0.25, rnd(r, 350, 600), 0.7, 0.002, 0.07, 'lp', brown), 0.9], [burst(r, 0.05, 1800, 0.8, 0.0005, 0.015), 0.3]]);
      return { x: drive(x, 1.8), note: `thump ${f0(a)} Hz falling, ${f2(d)} s, cloth smack` };
    },
  },
  {
    id: 'hit_limb_slap', label: 'Arm or limb slap', group: 'Hits', kind: 'oneshot', count: 10,
    event: 'plays when a hand, forearm or shin strikes another body (swims, rips, stiff arms)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 7) {
        const k = rnd(r, 1.15, 1.3), name = `impactPunch_medium_00${i - 6}`;
        return { x: layer(0.3, [[packed(c, IMPACT, name, k, 500, 0, 0.3), 1], [burst(r, 0.02, 2500, 0.8, 0.0003, 0.006), 0.5]]), source: IMPACT, note: `${src(IMPACT, name, k)}, high-passed, with synth skin snap` };
      }
      const f = 1200 + 2300 * v, d = rnd(r, 0.008, 0.025);
      const x = layer(0.15, [[burst(r, 0.12, f, 0.7, 0.0004, d), 1], [burst(r, 0.02, 4000, 0.7, 0.0002, 0.004, 'hp'), 0.4], [thump(0.06, 260, 160, 0.015), 0.35]]);
      return { x, note: `skin slap centred ${f0(f)} Hz, ${ms(d)} decay` };
    },
  },
  {
    id: 'hit_grab_jersey', label: 'Hand grab on jersey', group: 'Hits', kind: 'oneshot', count: 10,
    event: 'plays when a hand closes on a jersey or pads (cloth snatch)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const name = ['cloth1', 'cloth2', 'cloth3', 'cloth4', 'clothBelt'][i - 5], k = rnd(r, 0.9, 1.15);
        return { x: packed(c, RPG, name, k, 300, 0, 0.4), source: RPG, note: `${src(RPG, name, k)}, trimmed to the snatch` };
      }
      const len = 0.12 + 0.18 * v, rate = rnd(r, 1500, 4000), f = rnd(r, 2500, 4500), env = ahr(0.01, len * 0.4, len * 0.5);
      const x = layer(len + 0.05, [[crunch(r, len, rate, f, 0.7, env), 1.4], [hp(shape(pink(len, r), env), 1500), 0.3], [thump(0.05, 200, 120, 0.02), 0.2]]);
      return { x, note: `cloth crackle ${f0(rate)}/s around ${f0(f)} Hz, ${ms(len)}` };
    },
  },
  {
    id: 'hit_big_layer', label: 'Big hit boom layer', group: 'Hits', kind: 'oneshot', count: 8,
    event: 'layered under the hardest hits only (deep boom); scale with impact energy',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 6) {
        const k = i === 6 ? 0.6 : 0.75, lpF = i === 6 ? 300 : 450;
        const x = layer(1, [[packed(c, OGA1, 'explosion', k, 25, lpF), 1], [thump(0.4, 90, 32, 0.25, 2.5), 0.6]]);
        return { x, source: OGA1, note: `${src(OGA1, 'explosion', k)} low-passed ${lpF} Hz, with sub thump` };
      }
      const a = 60 + 22 * r(), b = rnd(r, 28, 36), d = 0.25 + 0.35 * v, type = i % 3;
      const boom = lp(drive(shape(osc(1, (t) => b + (a - b) * Math.exp(-t / 0.12)), ad(0.002, d)), 3), 700);
      let x = layer(1, [[boom, 1], [burst(r, 0.8, type === 1 ? 250 : 150, 0.7, 0.003, type === 1 ? 0.35 : 0.2, 'lp', brown), type === 1 ? 1.4 : 0.6], [thump(0.12, 150, 60, 0.03), 0.5]]);
      if (type === 2) x = mix(mix(x, burst(r, 0.3, 400, 0.7, 0.002, 0.06, 'bp', brown), 0.8), boom.slice(), 0.5, 0.06);
      return { x, note: `sub boom ${f0(a)} to ${f0(b)} Hz, ${f2(d)} s${['', ', heavy rumble', ', mid crunch and double hit'][type]}` };
    },
  },
  // ================= Bodies and ground
  {
    id: 'body_turf_tackle', label: 'Tackle to turf', group: 'Bodies and ground', kind: 'oneshot', count: 12,
    event: 'plays when a body slams onto the grass (tackle finish); louder with landing speed',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const g = `footstep_grass_00${i - 8}`, s = `impactSoft_heavy_00${(i - 7) % 5}`, k = rnd(r, 0.55, 0.65);
        const x = layer(0.7, [[packed(c, IMPACT, g, k, 80), 0.9], [packed(c, IMPACT, s, 0.8, 30, 2000), 1], [thump(0.3, 110, 42, 0.14), 0.5]]);
        return { x: drive(x, 1.4), source: IMPACT, note: `${src(IMPACT, g, k)} over ${s} at x0.80, synth thump` };
      }
      const a = 100 + 30 * v, d = rnd(r, 0.12, 0.2), rate = rnd(r, 2500, 5000), gl = rnd(r, 0.12, 0.2);
      let x = layer(0.65, [[thump(0.45, a, rnd(r, 40, 48), d), 1], [burst(r, 0.4, 400, 0.7, 0.003, 0.12, 'lp', brown), 0.9],
        [crunch(r, 0.5, rate, rnd(r, 3000, 5500), 0.6, ad(0.005, gl)), 1.2], [burst(r, 0.03, 1500, 1.2, 0.0003, 0.006), 0.3]]);
      if (i % 2) x = mix(x, thump(0.2, a * 0.9, 45, d * 0.5), 0.4, rnd(r, 0.08, 0.15));
      return { x: drive(x, 1.4), note: `body thump ${f0(a)} Hz ${f2(d)} s, grass crunch ${f0(rate)}/s${i % 2 ? ', second bounce' : ''}` };
    },
  },
  {
    id: 'body_turf_slide', label: 'Roll or slide on turf', group: 'Bodies and ground', kind: 'oneshot', count: 10,
    event: 'plays while a downed body rolls or slides on grass after a tackle',
    gen: ({ r, v }) => {
      const len = 0.5 + 0.4 * v, rate = rnd(r, 5, 11), ph = r() * 6, fTop = rnd(r, 1500, 2400), env = ahr(0.03, len - 0.25, 0.22);
      const am = (t: number) => (0.6 + 0.4 * Math.sin(2 * Math.PI * rate * t + ph) ** 2) * env(t);
      const x = layer(len, [[bp(shape(pink(len, r), am), (t) => fTop - 800 * (t / len), 0.8), 1], [crunch(r, len, 3000, 4000, 0.7, am), 0.8], [lp(shape(brown(len, r), env), 200), 0.4]]);
      return { x, note: `slide ${ms(len)}, ${f2(rate)} Hz roll bumps, band falling from ${f0(fTop)} Hz` };
    },
  },
  {
    id: 'body_dive_land', label: 'Dive landing', group: 'Bodies and ground', kind: 'oneshot', count: 10,
    event: 'plays when a diving player lands chest-first and skids',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 7) {
        const g = `footstep_grass_00${i - 5}`, s = `impactSoft_medium_00${i - 7}`, k = rnd(r, 0.45, 0.55);
        const x = layer(0.6, [[packed(c, IMPACT, g, k, 80), 0.9], [packed(c, IMPACT, s, 0.9, 40), 1]]);
        return { x, source: IMPACT, note: `${src(IMPACT, g, k)} with ${s} at x0.90` };
      }
      const a = 110 + 25 * v, tail = rnd(r, 0.1, 0.25);
      const x = layer(0.6, [[thump(0.3, a, 50, 0.09), 1], [burst(r, 0.03, 1200, 1.2, 0.0003, 0.008), 0.4], [crunch(r, 0.4, 3500, 4500, 0.6, ad(0.004, 0.15)), 1],
        [bp(shape(pink(tail + 0.1, r), ahr(0.02, tail, 0.12)), 1500, 0.8), 0.4, 0.05]]);
      return { x, note: `chest landing ${f0(a)} Hz, skid tail ${ms(tail)}` };
    },
  },
  {
    id: 'body_getup', label: 'Get-up rustle', group: 'Bodies and ground', kind: 'oneshot', count: 10,
    event: 'plays when a downed player pushes up and stands (pads, cloth, grass)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 6) {
        const name = ['cloth1', 'cloth2', 'cloth3', 'cloth4'][i - 6], k = rnd(r, 0.8, 0.95);
        const x = layer(0.9, [[packed(c, RPG, name, k, 200, 0, 0.6), 1], [packed(c, RPG, 'handleSmallLeather', rnd(r, 0.8, 1), 200, 0, 0.3), 0.5, 0.25], [crunch(r, 0.2, 3000, 5000, 0.7, ad(0.003, 0.05)), 0.6]]);
        return { x, source: RPG, note: `${src(RPG, name, k)} with handleSmallLeather (pads creak), synth grass push` };
      }
      const len = 0.6 + 0.3 * v, nb = 2 + (i % 3);
      let x = layer(len, [[crunch(r, 0.2, 3000, 5000, 0.7, ad(0.003, 0.05)), 0.7]]);
      for (let k = 0; k < nb; k++) {
        const at = rnd(r, 0.05, len - 0.25), h = rnd(r, 0.05, 0.12), e = ahr(0.02, h, 0.08);
        x = mix(x, layer(h + 0.12, [[crunch(r, h + 0.1, 2500, 3000, 0.7, e), 1.2], [hp(shape(pink(h + 0.1, r), e), 1200), 0.3]]), rnd(r, 0.5, 1), at);
        if (r() < 0.6) x = mix(x, modal(0.15, [{ f: rnd(r, 220, 300), a: 1, d: 0.03 }, { f: rnd(r, 550, 700), a: 0.5, d: 0.02 }], r), 0.25, at + 0.02);
      }
      return { x, note: `${nb} cloth and pad rustles over ${ms(len)}` };
    },
  },
  // ================= Feet
  {
    id: 'foot_jog', label: 'Cleat step (jog)', group: 'Feet', kind: 'oneshot', count: 16,
    event: 'plays on each foot strike at jog speed (cleats on grass)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const name = `footstep_grass_00${(i - 8) % 5}`, k = rnd(r, 0.85, 1.15);
        return { x: layer(0.3, [[packed(c, IMPACT, name, k, 120, 0, 0.28), 1], [crack(r, 5000, 0.0015), 0.25]]), source: IMPACT, note: `${src(IMPACT, name, k)} with synth stud click` };
      }
      const a = 150 + 40 * v, rate = rnd(r, 2000, 4000), f = rnd(r, 2500, 5000), d = rnd(r, 0.03, 0.06);
      const x = layer(0.22, [[thump(0.1, a, a / 2, 0.025), 0.8], [crunch(r, 0.2, rate, f, 0.6, ad(0.004, d)), 1.3], [crack(r, 5000, 0.0015), 0.3, rnd(r, 0, 0.005)], [burst(r, 0.1, 600, 0.7, 0.002, 0.03, 'lp', brown), 0.4]]);
      return { x, note: `jog step: thud ${f0(a)} Hz, grass ${f0(f)} Hz ${ms(d)}` };
    },
  },
  {
    id: 'foot_sprint', label: 'Cleat step (sprint)', group: 'Feet', kind: 'oneshot', count: 16,
    event: 'plays on each foot strike at sprint speed (harder, sharper, studs tearing turf)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const name = `footstep_grass_00${(i - 8) % 5}`, k = rnd(r, 1.1, 1.35);
        const x = layer(0.22, [[packed(c, IMPACT, name, k, 200, 0, 0.2), 1], [crack(r, 5500, 0.0012), 0.35], [burst(r, 0.05, 3000, 1, 0.001, 0.01), 0.3]]);
        return { x: drive(x, 1.5), source: IMPACT, note: `${src(IMPACT, name, k)}, driven, with synth stud tear` };
      }
      const a = 180 + 50 * v, rate = rnd(r, 4000, 7000), f = rnd(r, 3500, 6000), d = rnd(r, 0.025, 0.04);
      const x = layer(0.16, [[thump(0.08, a, a / 2.2, 0.02), 1], [crunch(r, 0.15, rate, f, 0.6, ad(0.002, d)), 1.4], [burst(r, 0.05, 3000, 1, 0.001, 0.01), 0.5], [crack(r, 5500, 0.0012), 0.35]]);
      return { x: drive(x, 1.4), note: `sprint step: thud ${f0(a)} Hz, tear ${f0(f)} Hz ${ms(d)}` };
    },
  },
  {
    id: 'foot_plant_skid', label: 'Plant and cut skid', group: 'Feet', kind: 'oneshot', count: 10,
    event: 'plays when a foot plants hard to cut or stop (cleats skid and tear grass)',
    gen: (c) => {
      const { r, i, v } = c;
      const len = 0.2 + 0.2 * v, env = ahr(0.01, len * 0.5, len * 0.4), fs = rnd(r, 3000, 4000);
      const skid = layer(len, [[bp(shape(pink(len, r), env), (t) => fs - 2000 * (t / len), 0.7), 1], [crunch(r, len, 6000, 4000, 0.7, env), 1]]);
      if (i >= 7) {
        const name = `footstep_grass_00${i - 7}`, k = rnd(r, 0.65, 0.75);
        return { x: layer(len + 0.1, [[packed(c, IMPACT, name, k, 100, 0, 0.35), 1], [skid, 0.6, 0.02]]), source: IMPACT, note: `${src(IMPACT, name, k)} with synth skid ${ms(len)}` };
      }
      return { x: layer(len + 0.05, [[thump(0.1, 160, 70, 0.03), 0.8], [skid, 1, 0.01]]), note: `plant thud then skid ${ms(len)}, band falling from ${f0(fs)} Hz` };
    },
  },
  // ================= Ball
  {
    id: 'ball_catch', label: 'Catch and tuck', group: 'Ball', kind: 'oneshot', count: 10,
    event: 'plays when hands secure the ball and tuck it to the body',
    gen: (c) => {
      const { r, i, v } = c;
      const pk = 280 + 180 * v, pok = modal(0.15, [{ f: pk, a: 1, d: 0.03 }, { f: pk * 2.2, a: 0.4, d: 0.02 }, { f: pk * 3.4, a: 0.2, d: 0.012 }], r);
      if (i >= 6) {
        const name = ['dropLeather', 'handleSmallLeather', 'handleSmallLeather2', 'beltHandle1'][i - 6], k = rnd(r, 0.9, 1.1);
        return { x: layer(0.4, [[packed(c, RPG, name, k, 150, 0, 0.35), 1], [pok, 0.5]]), source: RPG, note: `${src(RPG, name, k)} with synth ball pok ${f0(pk)} Hz` };
      }
      const tuck = rnd(r, 0.04, 0.1), sf = rnd(r, 800, 1800);
      const x = layer(0.3, [[burst(r, 0.05, sf, 0.9, 0.0003, 0.012), 1], [pok, 0.6], [crunch(r, 0.15, 2500, 3000, 0.7, ahr(0.01, 0.05, 0.06)), 0.5, tuck], [thump(0.08, 140, 80, 0.03), 0.4, tuck]]);
      return { x, note: `leather slap ${f0(sf)} Hz, ball ${f0(pk)} Hz, tuck at ${ms(tuck)}` };
    },
  },
  {
    id: 'ball_bounce', label: 'Fumble bounce on turf', group: 'Ball', kind: 'oneshot', count: 12,
    event: 'plays when a loose ball hits the grass; irregular bounces',
    gen: ({ r, i, v }) => {
      const nb = 1 + (i % 4), base = 170 + 90 * v;
      let x = buf(0.2), t = 0, a = 1, gap = rnd(r, 0.2, 0.32);
      for (let k = 0; k < nb; k++) {
        const f = base * rnd(r, 0.88, 1.12); // prolate ball: every bounce lands on a different part of the shell
        x = mix(x, layer(0.15, [[modal(0.15, [{ f, a: 1, d: rnd(r, 0.02, 0.035) }, { f: f * 2.1, a: 0.35, d: 0.015 }, { f: f * 3.3, a: 0.15, d: 0.01 }], r), 1], [burst(r, 0.08, 300, 0.7, 0.002, 0.03, 'lp', brown), 0.5]]), a, t);
        t += gap; gap *= rnd(r, 0.55, 0.85); a *= rnd(r, 0.45, 0.7);
      }
      return { x, note: `${nb} bounce${nb > 1 ? 's' : ''}, ball body ${f0(base)} Hz` };
    },
  },
  {
    id: 'ball_hit_body', label: 'Ball hits a body', group: 'Ball', kind: 'oneshot', count: 10,
    event: 'plays when the ball strikes a helmet, pads or body (batted pass, fumble)',
    gen: (c) => {
      const { r, i, v } = c;
      const pk = 220 + 140 * v, pok = modal(0.15, [{ f: pk, a: 1, d: 0.025 }, { f: pk * 2.3, a: 0.3, d: 0.015 }], r);
      if (i >= 7) {
        const name = `impactPunch_medium_00${i - 7}`, k = rnd(r, 1.25, 1.4);
        return { x: layer(0.3, [[packed(c, IMPACT, name, k, 150, 3000, 0.3), 1], [pok, 0.6]]), source: IMPACT, note: `${src(IMPACT, name, k)} low-passed, with synth ball pok` };
      }
      const sf = rnd(r, 600, 1200), pads = i % 2 === 1;
      let x = layer(0.25, [[burst(r, 0.05, sf, 0.8, 0.0005, 0.015), 0.8], [pok, 0.7], [thump(0.1, 120, 70, 0.04), 0.6], [crunch(r, 0.08, 2500, 3000, 0.7, ad(0.003, 0.04)), 0.4]]);
      if (pads) x = mix(x, burst(r, 0.04, rnd(r, 1300, 2000), 1.2, 0.0003, 0.008), 0.7);
      return { x, note: `slap ${f0(sf)} Hz, ball ${f0(pk)} Hz, ${pads ? 'off the pads (plastic clack)' : 'off the body (soft)'}` };
    },
  },
  // ================= Effort and air
  {
    id: 'air_whoosh', label: 'Whoosh (fast arm or body)', group: 'Effort and air', kind: 'oneshot', count: 12,
    event: 'plays when an arm or body moves fast near the camera (swim move, missed tackle)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 9) {
        const name = `sfx100v2_air_0${i - 8}`, k = rnd(r, 1.4, 1.8), len = 0.35;
        const raw = packed(c, OGA2, name, k), at = rnd(r, 0, Math.max(0, raw.length / SR - len - 0.01));
        const x = shape(lp(bp(slice(raw, at, at + len), 1200, 0.7), 5000), (t) => Math.sin(Math.PI * t / len) ** 2);
        return { x, source: OGA2, note: `${src(OGA2, name, k)}, a ${ms(len)} slice band-passed and swelled` };
      }
      const len = 0.15 + 0.3 * v, lo = rnd(r, 300, 500), hi = rnd(r, 900, 2500), q = rnd(r, 1.2, 2.5), sk = rnd(r, 0.6, 1.4);
      const sweep = (t: number) => lo + (hi - lo) * Math.sin(Math.PI * t / len) ** 1.5;
      const x = shape(bp(bp(pink(len, r), sweep, q), sweep, q), (t) => Math.sin(Math.PI * Math.pow(t / len, sk)) ** 2);
      return { x, note: `swish ${ms(len)}, sweep ${f0(lo)} to ${f0(hi)} Hz` };
    },
  },
  {
    id: 'air_wind_loop', label: 'Wind at top speed (loop)', group: 'Effort and air', kind: 'loop', count: 8, level: -22,
    event: 'loops while the controlled player runs fast; fade volume with speed',
    gen: ({ r, v }) => {
      const len = 6, xf = 1, T = len + xf, cf = 400 + 500 * v, p1 = r() * 6, p2 = r() * 6, fl = rnd(r, 16, 28), wf = rnd(r, 1800, 3000);
      const gust = (t: number) => 0.6 + 0.25 * Math.sin(2 * Math.PI * t / 2.3 + p1) + 0.15 * Math.sin(2 * Math.PI * t / 0.9 + p2);
      const x = layer(T, [[shape(bp(pink(T, r), (t) => cf * (1 + 0.25 * Math.sin(2 * Math.PI * t / 3.1 + p1) + 0.15 * Math.sin(2 * Math.PI * t / 1.3 + p2)), 0.6), gust), 1],
        [shape(lp(brown(T, r), 120), (t) => 0.5 + 0.5 * Math.sin(2 * Math.PI * fl * t)), 0.5], [shape(bp(white(T, r), wf, 12), gust), 0.4]]);
      return { x: loopify(x, xf), note: `wind band ${f0(cf)} Hz, ear flutter ${f0(fl)} Hz, ${len} s seamless loop` };
    },
  },
  {
    id: 'voice_grunt', label: 'Effort grunt (non-verbal)', group: 'Effort and air', kind: 'oneshot', count: 12,
    event: 'plays on big efforts: contact, shed, drive (synthesized voice, no words)',
    gen: ({ r, i, v }) => {
      const base = 95 + 50 * v, len = rnd(r, 0.15, 0.38), vw = ['uh', 'ah', 'hn', 'eh'][i % 4], fry = i % 3 === 0;
      const g = glottal(len, (t) => base * (1.12 - 0.2 * t / len) * (1 + 0.02 * Math.sin(2 * Math.PI * 6 * t)), r, fry ? 0.06 : 0.02, fry ? 0.4 : 0.6);
      const env = ahr(0.02, len * 0.4, len * 0.55);
      const x = layer(len, [[vowel(shape(g, env), VOWELS[vw]), 1], [vowel(shape(white(len, r), env), VOWELS[vw]), 0.12]]);
      return { x: drive(lp(x, 4000), 1.2), note: `grunt "${vw}" ${f0(base)} Hz, ${ms(len)}${fry ? ', strained' : ''}` };
    },
  },
  {
    id: 'voice_exhale', label: 'Exhale or huff (non-verbal)', group: 'Effort and air', kind: 'oneshot', count: 10,
    event: 'plays after sprints and on light efforts (breath, no voice or words)',
    gen: ({ r, i, v }) => {
      const len = 0.25 + 0.35 * v, f1 = rnd(r, 600, 800), f2_ = rnd(r, 1100, 1700);
      const env = (t: number) => ad(0.03, len * 0.35)(t) * Math.min(1, (len - t) / 0.05);
      let x = layer(len, [[formants(shape(white(len, r), env), [{ f: f1, bw: 300, g: 1 }, { f: f2_, bw: 400, g: 0.6 }, { f: 2500, bw: 600, g: 0.25 }]), 1], [lp(hp(shape(white(len, r), env), 2500), 6000), 0.05]]);
      if (i % 2) x = mix(x, vowel(shape(glottal(0.08, () => rnd(r, 100, 130), r), ahr(0.01, 0.03, 0.04)), VOWELS.uh), 0.15);
      return { x, note: `breath ${ms(len)}, formants ${f0(f1)}/${f0(f2_)} Hz${i % 2 ? ', voiced huff onset' : ''}` };
    },
  },
  // ================= Injuries (design §6.6). Voices are non-verbal and synthesized at human pitch and formants.
  {
    id: 'bone_crack', label: 'Bone crack or snap', group: 'Injuries', kind: 'oneshot', count: 10,
    event: 'plays when a joint breaks (knee, elbow, ankle, shoulder, collarbone); louder with the load that broke it',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 7) {
        const [pack, name] = ([[IMPACT, 'impactWood_light_002'], [IMPACT, 'impactWood_medium_001'], [OGA2, 'sfx100v2_wood_hit_02']] as const)[i - 7], k = rnd(r, 1.35, 1.7);
        const x = layer(0.4, [[packed(c, pack, name, k, 600, 0, 0.25), 1], [crack(r, 3000, 0.002), 0.7], [thump(0.12, 140, 70, 0.03), 0.2]]);
        return { x: drive(x, 1.6), source: pack, note: `${src(pack, name, k)}, cut to 250 ms, with synth crack and flesh thud` };
      }
      // A green branch snapping: a sharp click, a burst of fibres giving way, the bone's short ring, a wet crunch.
      const fib = rnd(r, 0.012, 0.05), rate = rnd(r, 4000, 9000), ringF = rnd(r, 900, 2400), split = i % 3 === 1;
      let x = layer(0.35, [[crack(r, rnd(r, 2000, 3500), rnd(r, 0.0015, 0.004)), 1],
        [crunch(r, fib + 0.01, rate, rnd(r, 2500, 4500), 0.8, ad(0.0005, fib * 0.5)), 1.3],
        [modal(0.08, [{ f: ringF, a: 1, d: rnd(r, 0.006, 0.015) }, { f: ringF * 2.7, a: 0.4, d: 0.005 }], r), 0.35],
        [burst(r, 0.12, rnd(r, 300, 600), 0.8, 0.001, rnd(r, 0.02, 0.05), 'lp', brown), 0.25 + 0.3 * v],
        [thump(0.15, 150, 70, 0.04), 0.25]]);
      if (split) x = mix(x, crack(r, 2800, 0.002), 0.7, rnd(r, 0.02, 0.05)); // a second fracture right behind
      return { x: drive(x, 1.5), note: `snap: fibres ${ms(fib)} at ${f0(rate)}/s, bone ring ${f0(ringF)} Hz${split ? ', double break' : ''}` };
    },
  },
  {
    id: 'pain_scream', label: 'Pain scream (non-verbal)', group: 'Injuries', kind: 'oneshot', count: 10,
    event: 'plays when a joint breaks: the hurt athlete screams (no words)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 8) {
        const name = RETRO_HUMAN + ['sfx_deathscream_human1.wav', 'sfx_deathscream_human2.wav'][i - 8], k = rnd(r, 1.3, 1.5);
        return { x: lp(packed(c, RETRO, name, k, 180, 0, 1.1), 5000), source: RETRO, note: `${src(RETRO, name.split('/').pop()!, k)}, low-passed 5 kHz (smooths the 8-bit grit)` };
      }
      const len = rnd(r, 0.6, 1.05), peakF = 380 + 200 * v, startF = peakF * rnd(r, 0.6, 0.75), rise = rnd(r, 0.08, 0.18), vib = rnd(r, 5, 7.5);
      const f = (t: number) => (t < rise ? startF + (peakF - startF) * Math.sin(Math.PI / 2 * t / rise) : peakF * (1 - 0.3 * ((t - rise) / (len - rise)) ** 2)) * (1 + 0.025 * Math.sin(2 * Math.PI * vib * t));
      const env = ahr(0.03, len * 0.55, len * 0.4), sc = rnd(r, 1.05, 1.2), tech = i % 4;
      if (tech === 1) {
        // source-filter: a tense, short-open glottal pulse through moving formants, plus breath
        const vw = glide('eh', 'ah', (t) => t / 0.2, sc);
        const g = shape(glottal(len, f, r, 0.015, 0.45), env);
        const x = layer(len, [[formants(g, [{ f: (t) => vw(t)[0], bw: 110, g: 1 }, { f: (t) => vw(t)[1], bw: 150, g: 1.2 }, { f: (t) => vw(t)[2], bw: 220, g: 0.9 }]), 1], [breath(r, len, vw(0.3), env), 0.25]]);
        return { x: lp(hp(x, 200), 6000), note: `pulse-train scream "eh-ah" ${f0(startF)} to ${f0(peakF)} Hz, ${ms(len)}` };
      }
      if (tech === 3) {
        // strained: roughness from a subharmonic (period doubling), the "cracking" voice of a scream
        const vw = glide('ah', 'uh', (t) => t / len, sc), a = additive(r, len, f, vw, { jitter: 0.03, shimmer: 0.25, bw: 1.4, tilt: 0.25 }), sub = additive(r, len, (t) => f(t) / 2, vw, { jitter: 0.03, bw: 1.4, tilt: 0.25 });
        return { x: lp(hp(layer(len, [[shape(a, env), 1], [shape(sub, (t) => env(t) * 0.35 * Math.min(1, t / 0.2)), 1], [breath(r, len, vw(0.2), env), 0.3]]), 180), 6000), note: `rough scream "ah" ${f0(peakF)} Hz with a subharmonic, ${ms(len)}` };
      }
      // additive: clean harmonics under a formant envelope (an open "aah", or "ow" closing to "oo")
      const ow = tech === 2, vw = ow ? glide('ah', 'oo', (t) => (t - len * 0.5) / (len * 0.4), sc) : glide('ah', 'ah', () => 0, sc);
      const x = layer(len, [[shape(additive(r, len, f, vw, { jitter: 0.02, shimmer: 0.15, bw: 1.2, tilt: 0.25 }), env), 1], [breath(r, len, vw(0), (t) => env(t) * (t < 0.08 ? 1.5 : 0.6)), 0.2]]);
      return { x: lp(hp(x, 180), 6000), note: `additive scream "${ow ? 'ow' : 'aah'}" ${f0(startF)} to ${f0(peakF)} Hz, vibrato ${f2(vib)} Hz, ${ms(len)}` };
    },
  },
  {
    id: 'pain_moan', label: 'Moan or groan on the turf (non-verbal)', group: 'Injuries', kind: 'long', count: 10, level: -18,
    event: 'plays every few seconds while a knocked-out or injured athlete lies on the turf (no words)',
    gen: (c) => {
      const { r, i, v } = c;
      const base = 105 + 85 * v, len = rnd(r, 1.2, 2.3), tech = i % 3, sc = rnd(r, 0.95, 1.05);
      // pitch: a slow rise into the moan, then a long fall as the breath runs out; a little wobble of pain
      const f = (t: number) => base * (1 + 0.18 * Math.sin(Math.PI * Math.min(1, t / (len * 0.6))) - 0.15 * Math.max(0, t / len - 0.6)) * (1 + 0.015 * Math.sin(2 * Math.PI * 4.5 * t));
      const env = ahr(rnd(r, 0.12, 0.25), len * 0.45, len * 0.45);
      if (tech === 0) {
        // a closed-mouth hum (low F1, nasal resonance) opening into "oh", breath
        const vw = glide('hn', 'oh', (t) => (t - 0.3 * len) / (0.4 * len), sc), x = additive(r, len, f, vw, { jitter: 0.02, shimmer: 0.2, bw: 1.6, top: 4000, tilt: 0.6 });
        return { x: lp(hp(hp(layer(len, [[shape(x, env), 1], [breath(r, len, VOWELS.hn, env), 0.15]]), 140), 140), 4000), note: `hummed groan "mm-oh" ${f0(base)} Hz, ${f2(len)} s` };
      }
      if (tech === 1) {
        // open "ohh-uhh" through a breathy pulse train, with a catch (a short break) in the middle
        const vw = glide('oh', 'uh', (t) => t / len, sc), gap = rnd(r, 0.35, 0.6) * len;
        const g = shape(glottal(len, f, r, 0.03, 0.65), (t) => env(t) * (Math.abs(t - gap) < 0.06 ? 0.15 : 1));
        const x = formants(g, [{ f: (t) => vw(t)[0], bw: 100, g: 1 }, { f: (t) => vw(t)[1], bw: 120, g: 0.5 }, { f: (t) => vw(t)[2], bw: 170, g: 0.25 }]);
        return { x: lp(hp(hp(layer(len, [[x, 1], [breath(r, len, VOWELS.oh, env), 0.3]]), 140), 140), 4500), note: `breathy moan "oh-uh" ${f0(base)} Hz with a catch, ${f2(len)} s` };
      }
      // a groan with creak: vocal fry (irregular low pulses) at its start and end, voice in the middle
      const vw = glide('uh', 'ah', (t) => t / len, sc), voice = additive(r, len, f, vw, { jitter: 0.03, shimmer: 0.25, bw: 1.3, top: 4000 });
      const fry = formants(shape(glottal(len, () => rnd(r, 35, 70), r, 0.25, 0.3), (t) => env(t) * (t < 0.3 || t > len - 0.4 ? 1 : 0.2)), [{ f: VOWELS.uh[0], bw: 120, g: 1 }, { f: VOWELS.uh[1], bw: 150, g: 0.5 }]);
      return { x: lp(hp(layer(len, [[shape(voice, (t) => env(t) * Math.min(1, t / 0.3)), 1], [fry, 0.5], [breath(r, len, VOWELS.uh, env), 0.2]]), 140), 4500), note: `creaky groan "uh-ah" ${f0(base)} Hz, ${f2(len)} s` };
    },
  },
  {
    id: 'ko_thud', label: 'Knockout thud', group: 'Injuries', kind: 'oneshot', count: 8,
    event: 'plays when an athlete is knocked out (the blow lands and he drops)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 6) {
        const name = `impactPunch_heavy_00${i - 5}`, k = rnd(r, 0.6, 0.7);
        const x = layer(0.9, [[packed(c, IMPACT, name, k, 30, 1500), 1], [thump(0.5, 80, 32, 0.2, 2.5), 0.7], [crack(r, 2500, 0.003), 0.4]]);
        return { x: drive(x, 1.6), source: IMPACT, note: `${src(IMPACT, name, k)}, low-passed, with sub thud and helmet click` };
      }
      const a = 70 + 30 * v, d = rnd(r, 0.15, 0.3), shell = rnd(r, 900, 1600);
      const x = layer(1, [[thump(0.7, a, 30, d, 2.5), 1], [crack(r, rnd(r, 2000, 3500), 0.003), 0.6], [ring(r, shell, 0.06), 0.25], [burst(r, 0.5, 250, 0.7, 0.003, 0.12, 'lp', brown), 0.8]]);
      return { x: lp(drive(x, 1.8), 6000), note: `deep thud ${f0(a)} Hz ${f2(d)} s, helmet clack ${f0(shell)} Hz` };
    },
  },
  {
    id: 'ko_ring', label: 'Knockout ringing (ears)', group: 'Injuries', kind: 'long', count: 8, level: -24,
    event: 'plays after a knockout: the ringing in the ears (quiet, under everything)',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 6) {
        const [pack, name] = ([[IMPACT, 'impactBell_heavy_001'], [OGA1, 'bell_02']] as const)[i - 6], k = rnd(r, 1.4, 1.8);
        const raw = packed(c, pack, name, k, 800);
        return { x: layer(1.6, [[raw, 0.6], [shape(osc(1.6, rnd(r, 3500, 5000)), ahr(0.05, 0.6, 0.9)), 0.4]]), source: pack, note: `${src(pack, name, k)} as a struck-bell "ding", with a ringing tone` };
      }
      const len = rnd(r, 1.6, 2.8), f = 3000 + 3500 * v, beat = rnd(r, 2, 6);
      // tinnitus: a pure high tone with a slow beat against a close second, fading; some with a low muffled hum
      const x = layer(len, [[osc(len, f), 1], [osc(len, f + beat), 0.6], [shape(lp(pink(len, r), 400), ahr(0.02, 0.2, 0.6)), i % 2 ? 0.5 : 0]]);
      return { x: shape(x, (t) => Math.min(1, t / 0.05) * Math.exp(-t / (len * 0.45))), note: `tinnitus ${f0(f)} Hz beating ${f2(beat)} Hz, ${f2(len)} s` };
    },
  },
  // ================= Game
  {
    id: 'game_whistle_start', label: 'Whistle (rep start)', group: 'Game', kind: 'oneshot', count: 8,
    event: 'plays when a rep starts (snap)',
    gen: ({ r, i, v }) => {
      const len = rnd(r, 0.25, 0.5), f = 2800 + 600 * v, rate = rnd(r, 22, 40), chirp = i % 2 ? 0.1 : 0;
      const x = reverb(blast(r, len, f, rate, rnd(r, 0.02, 0.05), rnd(r, 0.3, 0.6), chirp), 0.25, 1.2, 0.4);
      return { x, note: `single blast ${ms(len)}, ${f0(f)} Hz, pea trill ${f0(rate)} Hz${chirp ? ', chirped onset' : ''}` };
    },
  },
  {
    id: 'game_whistle_end', label: 'Whistle (rep end / tackle)', group: 'Game', kind: 'oneshot', count: 8, level: -15,
    event: 'plays when the rep ends (ball carrier down)',
    gen: ({ r, i, v }) => {
      const f = 2800 + 600 * v, rate = rnd(r, 22, 40), fm = rnd(r, 0.02, 0.05), am = rnd(r, 0.3, 0.6), type = i % 3;
      const lens = type === 0 ? [rnd(r, 0.55, 0.72)] : type === 1 ? [rnd(r, 0.2, 0.3), rnd(r, 0.3, 0.45)] : [0.14, 0.14, rnd(r, 0.2, 0.3)];
      let x = buf(0.1), t = 0;
      for (const l of lens) { x = mix(x, blast(r, l, f, rate, fm, am, 0.05), 1, t); t += l + rnd(r, 0.06, 0.1); }
      return { x: reverb(x, 0.25, 1.2, 0.4), note: `${['long blast', 'double blast', 'triple blast'][type]}, ${f0(f)} Hz, trill ${f0(rate)} Hz` };
    },
  },
  {
    id: 'crowd_cheer', label: 'Crowd cheer', group: 'Game', kind: 'long', count: 10, level: -16,
    event: 'plays after a great play (big tackle, broken tackle, touchdown)',
    gen: ({ r, i, v }) => {
      // Rebuilt 2026-10-18 (the owner rejected the pooled pulse-train crowd as a roar in a cave): many separate shouts
      // ("yeah", "woo", "hey") at the raised pitch people cheer at, each an additive voice with its own formants,
      // open air (two short slap echoes, no reverb tail) and the low end cut, so it stays bright and human.
      const len = rnd(r, 2.2, 2.9), shouts = Math.round(45 + 45 * v), env = ahr(0.2, len - 1.0, 0.75);
      let x = buf(len);
      for (let k = 0; k < shouts; k++) {
        const fem = r() < 0.45, base = fem ? rnd(r, 300, 480) : rnd(r, 170, 290), sc = fem ? 1.17 : 1, kind = Math.floor(r() * 3);
        const at = rnd(r, 0, 0.5) + (r() < 0.25 ? rnd(r, 0.4, 1.2) : 0), dur = Math.min(len - at - 0.05, rnd(r, 0.35, 1.1));
        if (dur < 0.2) continue;
        const f = kind === 1 ? (t: number) => base * (0.85 + 0.35 * Math.min(1, t / (dur * 0.6))) : (t: number) => base * (1 + 0.12 * Math.sin(Math.PI * Math.min(1, t / dur)));
        const vw = kind === 0 ? glide('eh', 'ah', (t) => t / (dur * 0.4), sc) : kind === 1 ? glide('oo', 'oo', () => 0, sc) : glide('eh', 'ee', (t) => t / dur, sc);
        const voice = shape(additive(r, dur, f, vw, { jitter: 0.02, shimmer: 0.2, bw: 1.5, top: 5000, tilt: 0.5 }), ahr(rnd(r, 0.03, 0.08), dur * 0.5, dur * 0.4));
        x = mix(x, voice, rnd(r, 0.15, 0.6) / Math.sqrt(shouts / 20), at);
      }
      x = x.slice(0, buf(len).length);
      // the crowd's breath and hiss: noise through an average open vowel, not a low rumble
      x = mix(x, shape(formants(pink(len, r), [{ f: 700, bw: 300, g: 1 }, { f: 1500, bw: 500, g: 0.6 }, { f: 2700, bw: 700, g: 0.3 }]), env), 0.25);
      x = mix(x, claps(r, len, Math.round(rnd(r, 120, 320)), env), 0.5);
      if (i % 2) for (let k = 0; k < 2; k++) { // a couple of finger whistles over the top
        const d = rnd(r, 0.4, 0.8), fw = rnd(r, 1800, 2800);
        x = mix(x, shape(osc(d, (t) => fw * (1 + 0.15 * Math.min(1, t / 0.15)) * (1 - 0.1 * Math.max(0, t - d * 0.7) / d)), ahr(0.04, d * 0.6, d * 0.3)), 0.05, rnd(r, 0.2, len - d - 0.1));
      }
      const slap = mix(mix(x.slice(), x, 0.25, rnd(r, 0.03, 0.05)), x, 0.12, rnd(r, 0.07, 0.11)).slice(0, x.length);
      return { x: lp(hp(hp(slap, 250), 250), 8000), note: `${shouts} separate additive shouts ("yeah", "woo", "hey") at 170-480 Hz, claps${i % 2 ? ', whistles' : ''}, open air, ${f2(len)} s` };
    },
  },
  {
    id: 'crowd_ooh', label: 'Crowd "ooh" (big hit)', group: 'Game', kind: 'long', count: 8, level: -16,
    event: 'plays after a very hard hit',
    gen: ({ r, v }) => {
      const len = rnd(r, 1.6, 2.4), voices = Math.round(60 + 60 * v), peakT = rnd(r, 0.35, 0.5);
      const pools: Record<string, Sig> = { m: buf(len), f: buf(len) };
      for (let k = 0; k < voices; k++) {
        const sex = r() < 0.4 ? 'f' : 'm', base = sex === 'f' ? rnd(r, 185, 290) : rnd(r, 95, 165), at = rnd(r, 0, 0.15), dur = len - at - rnd(r, 0, 0.3);
        const f = (t: number) => base * (t < peakT ? 1 + 0.25 * t / peakT : 1.25 - 0.35 * Math.min(1, (t - peakT) / (dur - peakT)));
        pools[sex] = mix(pools[sex], shape(glottal(dur, f, r, 0.02), ahr(rnd(r, 0.1, 0.2), dur * 0.35, dur * 0.5)), rnd(r, 0.3, 1), at);
      }
      const morph = (a: number, b: number, s: number) => (t: number) => s * (a + (b - a) * Math.min(1, t / len));
      let x = buf(len);
      for (const sex of ['m', 'f'] as const) {
        const s = sex === 'f' ? 1.17 : 1;
        x = mix(x, formants(pools[sex], [{ f: morph(300, 480, s), bw: 90 * s, g: 1 }, { f: morph(870, 800, s), bw: 110 * s, g: 0.5 }, { f: 2300 * s, bw: 160 * s, g: 0.2 }]));
      }
      x = mix(x, shape(lp(pink(len, r), 800), ahr(0.15, len * 0.4, len * 0.5)), 0.3);
      return { x: hp(reverb(x.slice(0, buf(len).length), 0.4, 1.6, 1.0, 0.82), 100), note: `${voices} synth voices "oo" to "oh", peak at ${ms(peakT)}` };
    },
  },
  {
    id: 'crowd_ambience_loop', label: 'Crowd ambience (loop)', group: 'Game', kind: 'loop', count: 8, level: -24,
    event: 'loops quietly under the whole drill',
    gen: ({ r, v }) => {
      const len = 8, xf = 1.5, T = len + xf, voices = Math.round(50 + 40 * v);
      const pools = new Map<string, Sig>();
      for (let k = 0; k < voices; k++) {
        const fem = r() < 0.4, base = fem ? rnd(r, 185, 260) : rnd(r, 95, 150), g = rnd(r, 0.2, 1);
        for (let t = rnd(r, 0, 1); t < T - 0.4; t += rnd(r, 0.15, 0.35) + (r() < 0.15 ? rnd(r, 0.5, 2) : 0)) {
          const d = rnd(r, 0.12, 0.3), key = `${pick(r, Object.keys(VOWELS))}|${fem ? 'f' : 'm'}`, inton = rnd(r, 0.9, 1.15);
          pools.set(key, mix(pools.get(key) ?? buf(T), shape(glottal(d, (u) => base * inton * (1 - 0.1 * u / d), r, 0.02), ahr(0.03, d * 0.4, d * 0.5)), g, t));
        }
      }
      let x = buf(T);
      for (const [key, p] of pools) { const [vw, sex] = key.split('|'); x = mix(x, vowel(p, VOWELS[vw], sex === 'f' ? 1.17 : 1)); }
      x = x.slice(0, buf(T).length);
      x = mix(x, lp(pink(T, r), 1200), 1.2);
      x = mix(x, claps(r, T, Math.round(rnd(r, 5, 25)), () => 0.5), 0.5);
      const y = reverb(lp(x, 3500), 0.5, 1.5, 0, 0.8);
      return { x: loopify(y, xf), note: `${voices} murmuring synth voices, distant claps, ${len} s seamless loop` };
    },
  },
  // ================= UI
  {
    id: 'ui_move', label: 'Menu move', group: 'UI', kind: 'oneshot', count: 10, level: -18,
    event: 'plays when the menu highlight moves',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const [pack, name] = ([[IFACE, 'tick_001'], [IFACE, 'tick_002'], [IFACE, 'scroll_003'], [UIA, 'rollover2'], [UIA, 'rollover4']] as const)[i - 5], k = rnd(r, 0.95, 1.1);
        return { x: packed(c, pack, name, k, 0, 0, 0.2), source: pack, note: src(pack, name, k) };
      }
      const f = 900 + 900 * v;
      return { x: layer(0.06, [[shape(osc(0.06, f), ad(0.001, 0.012)), 1], [shape(osc(0.06, 2 * f, 'tri'), ad(0.001, 0.006)), 0.2]]), note: `soft blip ${f0(f)} Hz` };
    },
  },
  {
    id: 'ui_select', label: 'Menu select', group: 'UI', kind: 'oneshot', count: 10, level: -18,
    event: 'plays when a menu item is chosen',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const [pack, name] = ([[IFACE, 'select_001'], [IFACE, 'select_002'], [IFACE, 'select_004'], [IFACE, 'select_006'], [UIA, 'click3']] as const)[i - 5], k = rnd(r, 0.95, 1.1);
        return { x: packed(c, pack, name, k, 0, 0, 0.3), source: pack, note: src(pack, name, k) };
      }
      const base = 520 + 360 * v, iv = [4, 5, 7, 7, 12][i];
      return { x: notes(0.25, [base, base * Math.pow(2, iv / 12)], 0.055, 0.03), note: `two notes up ${iv} semitones from ${f0(base)} Hz` };
    },
  },
  {
    id: 'ui_back', label: 'Menu back', group: 'UI', kind: 'oneshot', count: 10, level: -18,
    event: 'plays when leaving a menu or cancelling',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const [pack, name] = ([[IFACE, 'back_001'], [IFACE, 'back_002'], [IFACE, 'back_003'], [IFACE, 'back_004'], [IFACE, 'close_002']] as const)[i - 5], k = rnd(r, 0.95, 1.1);
        return { x: packed(c, pack, name, k, 0, 0, 0.3), source: pack, note: src(pack, name, k) };
      }
      const base = 700 + 300 * v;
      if (i % 2) return { x: shape(osc(0.12, (t) => base * Math.exp(-t * 6), 'tri'), ad(0.002, 0.04)), note: `falling sweep from ${f0(base)} Hz` };
      return { x: notes(0.25, [base, base * Math.pow(2, -5 / 12)], 0.055, 0.03), note: `two notes down from ${f0(base)} Hz` };
    },
  },
  {
    id: 'ui_slider_tick', label: 'Slider tick', group: 'UI', kind: 'oneshot', count: 10, level: -20,
    event: 'plays on each step while dragging a slider',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const [pack, name] = ([[IFACE, 'click_001'], [UIA, 'click1'], [UIA, 'click4'], [IFACE, 'tick_004'], [IFACE, 'switch_002']] as const)[i - 5], k = rnd(r, 0.95, 1.2);
        return { x: packed(c, pack, name, k, 0, 0, 0.06), source: pack, note: `${src(pack, name, k)}, cut to 60 ms` };
      }
      const f = 2000 + 2500 * v;
      return { x: layer(0.03, [[crack(r, rnd(r, 3000, 6000), 0.002), 0.6], [shape(osc(0.03, f), ad(0.0005, 0.006)), 0.5]]), note: `click with ${f0(f)} Hz ping` };
    },
  },
  {
    id: 'ui_confirm', label: 'Confirm', group: 'UI', kind: 'oneshot', count: 10, level: -18,
    event: 'plays when a setting is applied or a rep is confirmed',
    gen: (c) => {
      const { r, i, v } = c;
      if (i >= 5) {
        const [pack, name] = ([[IFACE, 'confirmation_001'], [IFACE, 'confirmation_002'], [IFACE, 'confirmation_003'], [IFACE, 'confirmation_004'], [IFACE, 'maximize_006']] as const)[i - 5], k = rnd(r, 0.95, 1.05);
        return { x: packed(c, pack, name, k, 0, 0, 0.6), source: pack, note: src(pack, name, k) };
      }
      const base = 520 + 260 * v, ch = [[0, 4, 7], [0, 7, 12], [0, 4, 7, 12], [0, 5, 9], [0, 3, 7, 10]][i];
      return { x: notes(0.6, ch.map((s) => base * Math.pow(2, s / 12)), 0.06 + 0.025 * (i % 2), 0.06, i < 3 ? 'tri' : 'sine'), note: `arpeggio ${ch.join('-')} from ${f0(base)} Hz` };
    },
  },
];
