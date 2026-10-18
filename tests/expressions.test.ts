// Eyebrow moods (game/expressions.ts, render/brows.ts): approach and charge make him angry, a hard hit angers both
// and a hit that leaves one down hurts him, injury and knockout are sad, and everything eases back to neutral.
import { describe, expect, it } from 'vitest';
import { approaching, ExpressionTracker, HIT_ANGRY, HIT_SAD } from '../src/game/expressions';
import { ExpressionDriver } from '../src/game/render/brows';
import type { World } from '../src/sim/world';

type Ath = { com: number[]; vel: number[]; team: number; down: boolean; out: boolean; thrust: boolean };
const DT = 1 / 120;

/** The bits of a World the tracker reads. */
class Fake {
  time = 0; dt = DT; hits: { a: number; b: number; force: number; speed: number }[] = [];
  ath: Ath[] = [
    { com: [0, 1, 0], vel: [0, 0, 0], team: 0, down: false, out: false, thrust: false },
    { com: [0, 1, 10], vel: [0, 0, 0], team: 1, down: false, out: false, thrust: false },
  ];
  get athletes() { return this.ath.map((a) => ({ downBy: a.down ? 'x' : null, injury: { out: a.out }, cmd: { thrustHips: a.thrust, dive: false }, setup: { team: a.team } })); }
  get scene() { return { athletes: this.ath.map((a) => ({ state: { com: a.com, comVel: a.vel } })) }; }
  as(): World { return this as unknown as World; }
}
const run = (f: Fake, tr: ExpressionTracker, seconds: number) => { let e = tr.step(f.as()); for (let t = 0; t < seconds; t += DT) { f.time += DT; f.hits = []; e = tr.step(f.as()); } return e; };

describe('expression state machine', () => {
  it('is neutral when nothing is happening', () => {
    const f = new Fake(), tr = new ExpressionTracker();
    expect(run(f, tr, 1)).toEqual([{ angry: 0, sad: 0 }, { angry: 0, sad: 0 }]);
  });

  it('angry while closing on an opponent within 5 m at speed, not far off, not slow, not running away', () => {
    const f = new Fake();
    f.ath[0].com = [0, 1, 6]; f.ath[0].vel = [0, 0, 7]; f.ath[1].com = [0, 1, 10]; // 4 m away, running at him
    expect(approaching(f.as(), 0, 1)).toBe(true);
    expect(approaching(f.as(), 1, 0)).toBe(false); // he is standing still
    f.ath[0].com = [0, 1, 2]; // 8 m
    expect(approaching(f.as(), 0, 1)).toBe(false);
    f.ath[0].com = [0, 1, 6]; f.ath[0].vel = [0, 0, 1.5]; // jogging in, slowly
    expect(approaching(f.as(), 0, 1)).toBe(false);
    f.ath[0].vel = [0, 0, -7]; // running away
    expect(approaching(f.as(), 0, 1)).toBe(false);
    f.ath[0].vel = [0, 0, 7]; f.ath[1].team = 0; // a teammate
    expect(new ExpressionTracker().step(f.as())[0].angry).toBe(0);
  });

  it('angry while charging (hips thrust), neutral again after', () => {
    const f = new Fake(), tr = new ExpressionTracker();
    f.ath[0].thrust = true;
    expect(run(f, tr, 0.1)[0].angry).toBe(1);
    f.ath[0].thrust = false;
    expect(run(f, tr, 0.1)[0].angry).toBe(0);
  });

  /** A hard collision: 12 kN for 0.2 s (360 N·s in any 30 ms window) at closing speeds that make it a big hit. */
  const collide = (f: Fake, tr: ExpressionTracker) => {
    f.ath[0].com = [0, 1, 9]; f.ath[0].vel = [0, 0, 6]; f.ath[1].com = [0, 1, 10]; f.ath[1].vel = [0, 0, -5]; // 11 m/s closing
    let e = tr.step(f.as());
    for (let t = 0; t < 0.2; t += DT) { f.time += DT; f.hits = [{ a: 0, b: 1, force: 12000, speed: 8 }]; e = tr.step(f.as()); }
    f.hits = [];
    f.ath[0].vel = f.ath[1].vel = [0, 0, 0]; f.ath[0].com = [0, 1, 0]; // apart again, standing
    return e;
  };

  it('a hard hit makes both angry for a couple of seconds, then neutral; a soft touch does nothing', () => {
    const f = new Fake(), tr = new ExpressionTracker();
    f.ath[0].com = [0, 1, 9.5]; f.ath[0].vel = [0, 0, 0.3]; f.ath[1].vel = [0, 0, 0];
    for (let t = 0; t < 0.2; t += DT) { f.time += DT; f.hits = [{ a: 0, b: 1, force: 100, speed: 0.3 }]; tr.step(f.as()); }
    f.hits = [];
    f.ath[0].com = [0, 1, 0];
    expect(run(f, tr, 0.3)[1].angry).toBe(0); // and the gap makes the next touch a new collision
    expect(collide(f, tr).map((e) => e.angry)).toEqual([1, 1]);
    expect(run(f, tr, HIT_ANGRY - 0.4)[1].angry).toBe(1);
    expect(run(f, tr, 0.6).map((e) => e.angry)).toEqual([0, 0]);
  });

  it('a hard hit that leaves him on the turf hurts him briefly (sad), not angry; a hit he stays up from does not', () => {
    const f = new Fake(), tr = new ExpressionTracker();
    collide(f, tr);
    f.ath[1].down = true;
    const e = run(f, tr, 0.1);
    expect(e[1]).toEqual({ angry: 0, sad: 0.8 });
    expect(e[0].sad).toBe(0);
    expect(run(f, tr, HIT_SAD + 0.2)[1]).toEqual({ angry: 0, sad: 0 }); // still down but over it
    const g = new Fake(), tg = new ExpressionTracker();
    collide(g, tg);
    run(g, tg, 5); // up the whole time
    g.ath[0].down = true; // goes down long after
    expect(run(g, tg, 0.1)[0].sad).toBe(0);
  });

  it('injured or knocked out is sad for as long as he is out, even in a charge or after a hit', () => {
    const f = new Fake(), tr = new ExpressionTracker();
    collide(f, tr);
    f.ath[1].out = true; f.ath[1].down = true; f.ath[1].thrust = true;
    expect(run(f, tr, 0.1)[1]).toEqual({ angry: 0, sad: 1 });
    expect(run(f, tr, 20)[1]).toEqual({ angry: 0, sad: 1 });
  });
});

describe('expression easing', () => {
  it('takes a fraction of a second to arrive, with no jump, and eases back to neutral', () => {
    const d = new ExpressionDriver();
    d.target = { angry: 1, sad: 0 };
    let prev = 0, at90 = 0;
    for (let t = 0; t < 1; t += 1 / 60) {
      const p = d.update(1 / 60).angry;
      expect(p - prev).toBeLessThan(0.2);
      if (!at90 && p > 0.9) at90 = t;
      prev = p;
    }
    expect(at90).toBeGreaterThan(0.15);
    expect(at90).toBeLessThan(0.4);
    d.target = { angry: 0, sad: 1 };
    for (let t = 0; t < 1.5; t += 1 / 60) d.update(1 / 60);
    expect(d.pose.angry).toBeLessThan(0.01);
    expect(d.pose.sad).toBeGreaterThan(0.99);
  });
});
