// Synthesised impact sounds (Web Audio, no samples): pad pops and body thumps whose loudness and
// brightness scale with measured contact force, plus cleat clicks.
export class Audio {
  private ctx: AudioContext | null = null;
  muted = false;
  private lastHit = 0;

  /** Browsers only allow audio after a user gesture; call from a key/button handler. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try { this.ctx = new AudioContext(); } catch { this.ctx = null; }
  }

  /** Impact with peak contact force F (N). */
  hit(F: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || F < 400) return;
    const now = ctx.currentTime;
    if (now - this.lastHit < 0.06) return;
    this.lastHit = now;
    const k = Math.min(1, F / 8000);
    const len = 0.12 + 0.18 * k;
    // filtered noise burst = pad pop
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.03));
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 600 + 1800 * k; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.25 + 0.6 * k, now); g.gain.exponentialRampToValueAtTime(0.001, now + len);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(now);
    // low body thump
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(110 + 60 * k, now); osc.frequency.exponentialRampToValueAtTime(45, now + len);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.4 * k + 0.1, now); og.gain.exponentialRampToValueAtTime(0.001, now + len);
    osc.connect(og).connect(ctx.destination);
    osc.start(now); osc.stop(now + len);
  }
}
