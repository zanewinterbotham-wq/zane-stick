// Hit feedback scaled from measured contact force and closing speed. Presentation only: none of this
// feeds back into the simulation (hit-stop pauses wall time; the sim still runs the same fixed steps).
export const BIG_HIT_N = 7000;           // slow motion, hit-stop and the results banner start here
export const MPH = 2.236936;             // (m/s) → mph

export interface HitFeel {
  k: number;          // 0..1 intensity
  shake: number;      // camera shake, m
  punch: number;      // camera lurch toward the hit, m
  rumble: { duration: number; strong: number; weak: number };
  stopMs: number;     // hit-stop length (wall time), 0 = none
  slowMo: boolean;
}

/** F: contact force (N); closing: approach speed at contact (m/s). */
export function hitFeel(F: number, closing: number): HitFeel {
  const kF = Math.min(1, F / 9000), kV = Math.min(1, Math.max(0, closing) / 8);
  // a hard push at walking pace should feel heavy, a full-speed collision of the same force bigger
  const k = Math.min(1, kF * (0.6 + 0.6 * kV));
  const big = F >= BIG_HIT_N;
  return {
    k, shake: 0.02 + 0.3 * k * k, punch: 0.4 * k,
    rumble: { duration: 80 + 160 * k, strong: k, weak: Math.min(1, k * 1.4) },
    stopMs: big ? Math.round(40 + 40 * k) : 0, slowMo: big,
  };
}
