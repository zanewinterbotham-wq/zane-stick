// Small offline DSP kit for the dev sound library. Mono Float32Array at SR. Dev tool only, never shipped.
export const SR = 44100;
export type Sig = Float32Array;
export type Rng = () => number;
type Fn = (t: number) => number;
const TAU = Math.PI * 2;

/** mulberry32: deterministic so every variant regenerates bit-identically. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export const rnd = (r: Rng, a: number, b: number) => a + (b - a) * r();
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const buf = (sec: number): Sig => new Float32Array(Math.max(1, Math.round(sec * SR)));
export const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

// ---- sources
export function white(sec: number, r: Rng): Sig {
  const x = buf(sec);
  for (let i = 0; i < x.length; i++) x[i] = r() * 2 - 1;
  return x;
}
/** Paul Kellet's economy pink filter. */
export function pink(sec: number, r: Rng): Sig {
  const x = buf(sec);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return x;
}
export function brown(sec: number, r: Rng): Sig {
  const x = buf(sec);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = 0.985 * y + (r() * 2 - 1) * 0.15; x[i] = y; }
  return x;
}
/** Sparse random impulses: filtered, they make grass crunch, cloth crackle and claps. */
export function crackle(sec: number, r: Rng, perSec: number): Sig {
  const x = buf(sec);
  const p = perSec / SR;
  for (let i = 0; i < x.length; i++) if (r() < p) x[i] = (r() * 2 - 1) * (0.3 + 0.7 * r());
  return x;
}
export type Wave = 'sine' | 'tri' | 'saw' | 'square';
export function osc(sec: number, f: number | Fn, wave: Wave = 'sine', phase = 0): Sig {
  const x = buf(sec);
  let ph = phase;
  for (let i = 0; i < x.length; i++) {
    const fr = typeof f === 'number' ? f : f(i / SR);
    const p = ph - Math.floor(ph);
    x[i] = wave === 'sine' ? Math.sin(TAU * p) : wave === 'saw' ? 2 * p - 1 : wave === 'square' ? (p < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(p - 0.5);
    ph += fr / SR;
  }
  return x;
}
/** Struck object: decaying sinusoidal modes (shell ring, pad plastic, ball body). */
export function modal(sec: number, modes: { f: number; a: number; d: number }[], r?: Rng): Sig {
  const x = buf(sec);
  for (const m of modes) {
    if (m.f >= SR * 0.45) continue;
    const ph = r ? r() * TAU : 0, w = TAU * m.f / SR, k = Math.exp(-1 / (m.d * SR));
    let e = m.a;
    for (let i = 0; i < x.length; i++) { x[i] += e * Math.sin(w * i + ph); e *= k; }
  }
  return fade(x, 0.0005, 0); // random phases would otherwise start with a step (broadband click)
}
/** Glottal pulse train (Rosenberg flow derivative) with jitter, for non-verbal grunts and crowd voices. */
export function glottal(sec: number, f0: Fn, r: Rng, jitter = 0.01, open = 0.6): Sig {
  const x = buf(sec);
  let ph = 0, jit = 1, prev = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (f0(i / SR) * jit) / SR;
    if (ph >= 1) { ph -= 1; jit = 1 + (r() * 2 - 1) * jitter; }
    const flow = ph < open ? 0.5 * (1 - Math.cos(Math.PI * ph / open)) : Math.max(0, Math.cos((Math.PI * (ph - open)) / (2 * (1 - open) * 0.6)));
    x[i] = (flow - prev) * 40; prev = flow;
  }
  return x;
}

// ---- filters (RBJ biquads; f may vary with time, coefficients refresh every 16 samples)
export type FType = 'lp' | 'hp' | 'bp' | 'peak';
export function biquad(x: Sig, type: FType, f: number | Fn, q = 0.707, gainDb = 0): Sig {
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const set = (fr: number) => {
    const w = TAU * Math.min(Math.max(fr, 10), SR * 0.45) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    let a0 = 1 + al;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c / a0; a2 = (1 - al / A) / a0; b0 /= a0; b1 /= a0; b2 /= a0; return; }
    a1 = -2 * c / a0; a2 = (1 - al) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
  };
  if (typeof f === 'number') set(f);
  for (let i = 0; i < x.length; i++) {
    if (typeof f !== 'number' && (i & 15) === 0) set(f(i / SR));
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
export const lp = (x: Sig, f: number | Fn, q = 0.707) => biquad(x, 'lp', f, q);
export const hp = (x: Sig, f: number | Fn, q = 0.707) => biquad(x, 'hp', f, q);
export const bp = (x: Sig, f: number | Fn, q = 1) => biquad(x, 'bp', f, q);
export const eq = (x: Sig, f: number, db_: number, q = 1) => biquad(x, 'peak', f, q, db_);
/** Parallel formant bank (vowel colour). */
export function formants(x: Sig, fs: { f: number | Fn; bw: number; g: number }[]): Sig {
  const out = new Float32Array(x.length);
  for (const fm of fs) {
    const y = biquad(Float32Array.from(x), 'bp', fm.f, (typeof fm.f === 'number' ? fm.f : fm.f(0)) / fm.bw);
    for (let i = 0; i < out.length; i++) out[i] += y[i] * fm.g;
  }
  return out;
}

// ---- envelopes, shaping, mixing
export function shape(x: Sig, env: Fn): Sig {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / SR);
  return x;
}
/** Linear attack then exponential decay (time constant d). */
export const ad = (a: number, d: number): Fn => (t) => (t < a ? t / a : Math.exp(-(t - a) / d));
/** Attack, hold, release (raised-cosine edges). */
export const ahr = (a: number, h: number, rel: number): Fn => (t) =>
  t < a ? 0.5 - 0.5 * Math.cos(Math.PI * t / a) : t < a + h ? 1 : t < a + h + rel ? 0.5 + 0.5 * Math.cos(Math.PI * (t - a - h) / rel) : 0;
export function drive(x: Sig, k: number): Sig {
  const n = Math.tanh(k);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(k * x[i]) / n;
  return x;
}
export function gain(x: Sig, g: number): Sig { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
export function peak(x: Sig): number { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; }
export function norm(x: Sig, to = 1): Sig { const p = peak(x); return p > 0 ? gain(x, to / p) : x; }
/** Adds src*g into dst at time `at` (dst grows if needed); returns the (possibly new) dst.
 *  The last 5 ms of src are faded so a layer cut off mid-decay never clicks. */
export function mix(dst: Sig, src: Sig, g = 1, at = 0): Sig {
  const o = Math.round(at * SR), F = Math.max(1, Math.min(Math.round(0.005 * SR), src.length >> 2)), tail = src.length - F;
  let d = dst;
  if (o + src.length > d.length) { d = new Float32Array(o + src.length); d.set(dst); }
  for (let i = 0; i < src.length; i++) d[o + i] += src[i] * g * (i < tail ? 1 : (src.length - i) / F);
  return d;
}
export function layer(len: number, parts: [Sig, number, number?][]): Sig {
  let x = buf(len);
  for (const [s, g, at] of parts) x = mix(x, s, g, at ?? 0);
  return x;
}
/** Pitch/speed change by linear-interpolated resampling (ratio > 1 = higher and shorter). */
export function resample(x: Sig, ratio: number): Sig {
  const n = Math.max(1, Math.floor((x.length - 1) / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; y[i] = x[k] * (1 - f) + (x[k + 1] ?? 0) * f; }
  return y;
}
export function slice(x: Sig, from: number, to: number): Sig { return x.slice(Math.round(from * SR), Math.round(to * SR)); }
export function fade(x: Sig, inSec: number, outSec: number): Sig {
  const a = Math.round(inSec * SR), b = Math.round(outSec * SR);
  for (let i = 0; i < a && i < x.length; i++) x[i] *= i / a;
  for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i] *= i / b;
  return x;
}
/** Small Schroeder reverb (4 damped combs + 2 allpasses); size scales the delay lines. */
export function reverb(x: Sig, wet: number, size = 1, tail = 0.8, fb = 0.78): Sig {
  const n = x.length + Math.round(tail * SR);
  const out = new Float32Array(n), dry = new Float32Array(n);
  dry.set(x);
  for (const d0 of [1557, 1617, 1491, 1422]) {
    const d = Math.round(d0 * size), line = new Float32Array(d);
    let p = 0, lpz = 0;
    for (let i = 0; i < n; i++) { const y = line[p]; lpz = y * 0.6 + lpz * 0.4; line[p] = dry[i] + lpz * fb; p = (p + 1) % d; out[i] += y * 0.25; }
  }
  for (const d0 of [225, 556]) {
    const d = Math.round(d0 * size), line = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < n; i++) { const b = line[p], y = -0.5 * out[i] + b; line[p] = out[i] + 0.5 * y; p = (p + 1) % d; out[i] = y; }
  }
  for (let i = 0; i < n; i++) out[i] = dry[i] * (1 - wet * 0.5) + out[i] * wet;
  return out;
}
/** Make a seamless loop: render len+xf seconds, fold the extra tail over the head with an equal-power crossfade. */
export function loopify(x: Sig, xfSec: number): Sig {
  const X = Math.round(xfSec * SR), L = x.length - X, y = x.slice(0, L);
  for (let i = 0; i < X; i++) { const t = i / X; y[i] = x[i] * Math.sin(t * Math.PI / 2) + x[L + i] * Math.cos(t * Math.PI / 2); }
  return y;
}

// ---- analysis (shared by the build checks)
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -TAU / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], j = i + k + len / 2;
        const vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
export const BAND_EDGES = [0, 100, 250, 500, 1000, 2000, 4000, 8000, 22050];
export interface Stats { duration: number; peak: number; rmsDb: number; momentaryDb: number; onset: number; centroid: number; bands: number[]; segments: number[]; clipped: number; loopJump: number }
/** Peak, RMS, loudest 50 ms RMS, onset, spectral centroid, 8-band and 8-time-segment energy shares, clipped samples, loop seam jump. */
export function analyse(x: Sig): Stats {
  let pk = 0, ss = 0, clipped = 0;
  const segments = new Array(8).fill(0);
  x.forEach((v, i) => { const a = Math.abs(v); pk = Math.max(pk, a); ss += v * v; segments[Math.floor((i * 8) / x.length)] += v * v; if (a >= 0.999) clipped++; });
  const w = Math.round(0.05 * SR);
  let acc = 0, mom = 0;
  for (let i = 0; i < x.length; i++) { acc += x[i] * x[i]; if (i >= w) acc -= x[i - w] * x[i - w]; mom = Math.max(mom, acc / Math.min(i + 1, w)); }
  let on = 0;
  while (on < x.length && Math.abs(x[on]) < pk * 0.01) on++;
  const N = 2048, bands = new Array(BAND_EDGES.length - 1).fill(0);
  let num = 0, den = 0;
  for (let s = 0; s < x.length; s += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N && s + i < x.length; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(TAU * i / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], f = k * SR / N;
      num += f * p; den += p;
      let b = 0;
      while (f >= BAND_EDGES[b + 1]) b++;
      bands[b] += p;
    }
  }
  let dsum = 0;
  for (let i = 1; i < x.length; i++) dsum += (x[i] - x[i - 1]) ** 2;
  const dRms = Math.sqrt(dsum / Math.max(1, x.length - 1));
  return {
    duration: x.length / SR, peak: pk, rmsDb: db(Math.sqrt(ss / x.length)), momentaryDb: 10 * Math.log10(Math.max(mom, 1e-24)),
    onset: on / SR, centroid: den > 0 ? num / den : 0, bands: bands.map((b) => (den > 0 ? b / den : 0)), segments: segments.map((s) => (ss > 0 ? s / ss : 0)),
    clipped, loopJump: dRms > 0 ? Math.abs(x[x.length - 1] - x[0]) / dRms : 0,
  };
}
