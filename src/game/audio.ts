// Game sound: the owner's picked samples (public/sfx, listed in sfx-picks.json by `npm run sfx:export`) and,
// for a hit category with no picks, the synthesised impact voices (Web Audio noise and tones: helmet crack and
// ring, pad thud, body slap, cloth grab). Loudness follows the measured closing speed and force, positional
// sounds fade with distance from the camera and pan by side, and every play is jittered.
/// <reference types="vite/client" />
import { Rng } from '../sim/rng';
import type { HitKind, HitSound } from './feel';
import picks from './sfx-picks.json';

export interface SfxCategory { volume: number; files: string[] }

/** Shortest gap between two sounds of a category (s), so a burst of events does not machine-gun. */
const COOLDOWN: Record<string, number> = {
  hit_big_layer: 0.5, crowd_ooh: 3, voice_grunt: 0.35, voice_exhale: 0.8, foot_plant_skid: 0.5, body_turf_tackle: 0.4,
  body_turf_slide: 0.45, body_dive_land: 0.5, body_getup: 1, ball_catch: 0.3, ball_bounce: 0.08, ball_hit_body: 0.1,
  air_whoosh: 0.12, game_whistle_start: 1, ui_move: 0.03, ui_slider_tick: 0.06,
  bone_crack: 0.05, pain_scream: 0.6, pain_moan: 1.2, ko_thud: 0.3, ko_ring: 2,
};
const DEFAULT_COOLDOWN = 0.03;
const HIT_CAT: Record<HitKind, string> = { helmet: 'hit_helmet_helmet', helmetPads: 'hit_helmet_pads', pads: 'hit_pads_pads', body: 'hit_body_body', grab: 'hit_grab_jersey' };
/** Positional sounds play at full level within this distance of the camera (m), then fall off as 1/d. */
const NEAR = 4;
const MASTER = 0.9;

/** Which variant plays and how loud: random, never the same one twice in a row, quiet during the cooldown. */
export class SampleChooser {
  private last = new Map<string, { i: number; t: number }>();
  constructor(readonly cats: Record<string, SfxCategory>, private rng: Rng) {}
  has(cat: string) { return !!this.cats[cat]?.files.length; }
  /** `loud` 0..1 is the event's loudness; `now` in seconds. Null = no picks or still cooling down. */
  choose(cat: string, loud: number, now: number): { file: string; gain: number; rate: number } | null {
    const c = this.cats[cat], prev = this.last.get(cat);
    if (!c?.files.length || (prev && now - prev.t < (COOLDOWN[cat] ?? DEFAULT_COOLDOWN))) return null;
    const n = c.files.length, skip = prev && n > 1 ? prev.i : -1;
    let i = Math.floor(this.rng.next() * (skip >= 0 ? n - 1 : n));
    if (skip >= 0 && i >= skip) i++;
    this.last.set(cat, { i, t: now });
    return { file: c.files[i], gain: c.volume * loud, rate: 1 + this.rng.range(-0.04, 0.04) };
  }
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private rng = new Rng(0x5eed);
  private chooser = new SampleChooser(picks.categories, new Rng(0x5a3c));
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private loopSrc: AudioBufferSourceNode | null = null;
  private loopWant: string | null = null;
  private ear = { pos: [0, 1.6, -3], right: [-1, 0, 0] };
  private lastAt = 0;
  private lastLoud = 0;
  private mute = false;

  get muted() { return this.mute; }
  set muted(v: boolean) { this.mute = v; if (this.master) this.master.gain.value = v ? 0 : MASTER; }

  /** Browsers only allow audio after a user gesture; call from a key/button handler. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try { this.ctx = new AudioContext(); } catch { this.ctx = null; return; }
    const ctx = this.ctx;
    // a pile-up of contacts in one frame must not clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
    const master = ctx.createGain(); master.gain.value = this.mute ? 0 : MASTER;
    master.connect(comp).connect(ctx.destination);
    this.master = this.out = master;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = this.rng.next() * 2 - 1;
    // everything picked is under 1 MB: fetch it all now so the first hit of a rep is not silent
    for (const c of Object.values(this.chooser.cats)) for (const f of c.files) void this.load(f);
    if (this.loopWant) this.loop(this.loopWant);
  }

  /** Camera position and its right axis (world), for distance fall-off and stereo pan. */
  listen(pos: ArrayLike<number>, right: ArrayLike<number>) {
    for (let k = 0; k < 3; k++) { this.ear.pos[k] = pos[k]; this.ear.right[k] = right[k]; }
  }

  private load(file: string): Promise<AudioBuffer | null> {
    let p = this.loading.get(file);
    if (!p) {
      const ctx = this.ctx!;
      p = fetch(import.meta.env.BASE_URL + file).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
        .then((b) => { this.buffers.set(file, b); return b; }, (e) => { console.warn('sound failed to load', file, e); return null; });
      this.loading.set(file, p);
    }
    return p;
  }

  /** Play a picked sound of `cat` at loudness 0..1, at a world position (positional) or not (UI, crowd).
   *  Returns false when the category has no picks. */
  play(cat: string, loud: number, pos?: ArrayLike<number>): boolean {
    if (!this.chooser.has(cat)) return false;
    const ctx = this.ctx;
    if (!ctx || !this.out || this.mute || loud < 0.01) return true;
    let pan = 0;
    if (pos) {
      const d = [pos[0] - this.ear.pos[0], pos[1] - this.ear.pos[1], pos[2] - this.ear.pos[2]], r = Math.hypot(d[0], d[1], d[2]);
      loud *= Math.min(1, NEAR / Math.max(r, 1e-6));
      pan = r > 0.5 ? 0.6 * (d[0] * this.ear.right[0] + d[1] * this.ear.right[1] + d[2] * this.ear.right[2]) / r : 0;
    }
    const c = this.chooser.choose(cat, loud, ctx.currentTime);
    if (!c) return true;
    const asked = ctx.currentTime;
    const start = (b: AudioBuffer) => {
      const src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
      src.buffer = b; src.playbackRate.value = c.rate; g.gain.value = c.gain; p.pan.value = pan;
      src.connect(g).connect(p).connect(this.out!);
      src.start();
    };
    const b = this.buffers.get(c.file);
    // not decoded yet (first sounds after unlock): play it if it arrives while still in time
    if (b) start(b); else void this.load(c.file).then((x) => { if (x && ctx.currentTime - asked < 0.15) start(x); });
    return true;
  }

  /** Start (cat) or stop (null) the looping background bed. */
  loop(cat: string | null) {
    this.loopWant = cat;
    if (!cat) { this.loopSrc?.stop(); this.loopSrc = null; return; }
    const ctx = this.ctx, c = this.chooser.cats[cat];
    if (!ctx || !this.out || this.loopSrc || !c?.files.length) return;
    void this.load(c.files[0]).then((b) => {
      if (!b || this.loopWant !== cat || this.loopSrc) return;
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = b; src.loop = true; g.gain.value = c.volume;
      src.connect(g).connect(this.out!);
      src.start();
      this.loopSrc = src;
    });
  }

  hit(s: HitSound) {
    const ctx = this.ctx;
    if (!ctx || !this.out || this.mute || s.loud < 0.03) return;
    const now = ctx.currentTime;
    // a quieter contact right behind a louder one is masked anyway
    if (now - this.lastAt < 0.03 && s.loud < 0.5 * this.lastLoud) return;
    this.lastAt = now; this.lastLoud = s.loud;
    const k = s.loud, j = (x: number) => x * (1 + this.rng.range(-0.12, 0.12));
    const amp = 0.06 + 0.94 * k * k; // light touches stay quiet
    if (this.play(s.kind === 'body' && s.limb ? 'hit_limb_slap' : HIT_CAT[s.kind], amp, s.pos)) return;
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
