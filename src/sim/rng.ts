/** Seeded PRNG (mulberry32). The only source of randomness allowed inside the sim. */
export class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number) { return lo + (hi - lo) * this.next(); }
  /** Approximately normal, mean 0, sd 1 (sum of uniforms). */
  gauss() { let s = 0; for (let i = 0; i < 6; i++) s += this.next(); return (s - 3) * Math.SQRT2; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
}
