// Synthesised impact sounds (Web Audio, no samples). Each body-part contact gets a voice for the surfaces
// that met (helmet crack and ring, pad thud, body slap, cloth grab); loudness and brightness follow the
// measured closing speed and force, and every hit is jittered so no two sound the same.
import { Rng } from '../sim/rng';
import type { HitKind, HitSound } from './feel';

export class Audio {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private rng = new Rng(0x5eed);
  private lastAt = 0;
  private lastLoud = 0;
  muted = false;

  /** Browsers only allow audio after a user gesture; call from a key/button handler. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try { this.ctx = new AudioContext(); } catch { this.ctx = null; return; }
    const ctx = this.ctx;
    // a pile-up of contacts in one frame must not clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
    const master = ctx.createGain(); master.gain.value = 0.9;
    master.connect(comp).connect(ctx.destination);
    this.out = master;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = this.rng.next() * 2 - 1;
  }

  hit(s: HitSound) {
    const ctx = this.ctx;
    if (!ctx || !this.out || this.muted || s.loud < 0.03) return;
    const now = ctx.currentTime;
    // a quieter contact right behind a louder one is masked anyway
    if (now - this.lastAt < 0.03 && s.loud < 0.5 * this.lastLoud) return;
    this.lastAt = now; this.lastLoud = s.loud;
    const k = s.loud, j = (x: number) => x * (1 + this.rng.range(-0.12, 0.12));
    const amp = 0.06 + 0.94 * k * k; // light touches stay quiet
    const v: Record<HitKind, () => void> = {
      helmet: () => { this.crack(now, amp, k, j); this.ring(now, amp * 0.5, j(1900 + 900 * k), j(0.18 + 0.15 * k)); },
      helmetPads: () => { this.crack(now, amp * 0.8, k, j); this.ring(now, amp * 0.15, j(1500 + 600 * k), 0.07); this.thud(now, amp * 0.8, k, j); },
      pads: () => { this.burst(now, amp * 0.9, 'bandpass', j(450 + 700 * k), 1.1, j(0.05 + 0.04 * k)); this.thud(now, amp, k, j); },
      body: () => { this.burst(now, amp * 0.7, 'lowpass', j(500 + 900 * k), 0.7, j(0.035 + 0.03 * k)); this.thud(now, amp * 0.6, k * 0.7, j); },
      grab: () => this.burst(now, 0.08 + 0.25 * k, 'bandpass', j(2600), 0.9, j(0.06), 0.012),
    };
    v[s.kind]();
  }

  /** Filtered slice of the noise buffer with an exponential decay (attack > 0 fades in, for cloth). */
  private burst(t: number, amp: number, type: BiquadFilterType, freq: number, q: number, decay: number, attack = 0) {
    const ctx = this.ctx!, src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(attack ? 0.0001 : amp, t);
    if (attack) g.gain.exponentialRampToValueAtTime(amp, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay * 5);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t, this.rng.range(0, 0.8), attack + decay * 5);
  }

  /** Hard-shell crack: a very short, bright noise click. */
  private crack(t: number, amp: number, k: number, j: (x: number) => number) {
    this.burst(t, amp, 'highpass', j(1800 + 2500 * k), 0.8, j(0.004 + 0.003 * k));
  }

  /** Shell ring: two inharmonic partials decaying together. */
  private ring(t: number, amp: number, f0: number, decay: number) {
    for (const [ratio, a] of [[1, 1], [2.37, 0.45]]) this.tone(t, amp * a, 'sine', f0 * ratio, f0 * ratio * 0.98, decay / ratio);
  }

  /** Low body thump: a sine dropping in pitch. */
  private thud(t: number, amp: number, k: number, j: (x: number) => number) {
    this.tone(t, amp, 'sine', j(95 + 70 * k), 42, j(0.05 + 0.05 * k));
  }

  private tone(t: number, amp: number, type: OscillatorType, f0: number, f1: number, decay: number) {
    const ctx = this.ctx!, osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(f1, t + decay * 3);
    const g = ctx.createGain(); g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + decay * 5);
    osc.connect(g).connect(this.out!);
    osc.start(t); osc.stop(t + decay * 5);
  }
}
