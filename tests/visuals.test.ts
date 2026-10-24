// Better visuals (presentation only): turf kick-up and scuffs, uniform identities and grass stains, the crowd's mood,
// decal spots on a skin, the end-of-rep stats and which quality levels get which extras.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/game/presets';
import { CHEER_FADE, CrowdFx, WAVE_TIME } from '../src/game/render/crowd';
import { FLOODLIGHTS } from '../src/game/render/lights';
import { kickIntensity, slideIntensity, TurfMarks } from '../src/game/render/turf';
import { addStain, clearStains, identFor, skinSpots, stainKey, stainOf } from '../src/game/render/uniform';
import { impulseKN, RepStats, YD } from '../src/game/repStats';
import type { World } from '../src/sim/world';

describe('turf kick-up', () => {
  it('a jog throws nothing, a hard plant a lot, a crawl nothing', () => {
    expect(kickIntensity(5, 10)).toBe(0);
    expect(kickIntensity(2, 80)).toBe(0);
    expect(kickIntensity(7, 40)).toBeGreaterThan(0.2);
    expect(kickIntensity(7, 200)).toBe(1);
    expect(slideIntensity(1)).toBe(0);
    expect(slideIntensity(9)).toBe(1);
  });

  /** A one-athlete world: a sprinter planting a foot while his velocity swings, or a fallen body sliding. */
  const fake = () => ({
    time: 0,
    athletes: [{ feet: [{ touching: true }, { touching: false }], downBy: null as number | null, segIndex: new Map([['footL', 0], ['footR', 1], ['pelvis', 2]]) }],
    scene: { athletes: [{ state: { comVel: [0, 0, 0], segPos: new Float64Array(9) } }] },
  });
  const at = (w: ReturnType<typeof fake>, time: number, vel: number[], down = false) => { w.time = time; w.scene.athletes[0].state.comVel = vel; w.athletes[0].downBy = down ? 0 : null; return w as unknown as World; };

  it('a hard cut throws turf and leaves a scuff that stays until the next rep; a slide scrapes too', () => {
    const t = new TurfMarks(), w = fake();
    const meshes = t.root.children as unknown as { count: number }[];
    t.follow(at(w, 0, [8, 0, 0]), [], 1 / 60); // first reading
    t.follow(at(w, 0.05, [8, 0, 6]), [], 1 / 60); // a 120 m/s² sideways swing
    expect(meshes[0].count).toBeGreaterThan(0); // particles in the air
    expect(meshes[1].count).toBe(1); // one scuff
    for (let i = 0; i < 120; i++) t.follow(at(w, 0.05, [8, 0, 6]), [], 1 / 60);
    expect(meshes[0].count).toBe(0); // everything landed
    expect(meshes[1].count).toBe(1); // the scuff stays
    t.follow(at(w, 1, [6, 0, 0], true), [], 1 / 60); // down and sliding
    expect(meshes[1].count).toBe(2);
    t.follow(at(fake(), 0, [0, 0, 0]), [], 1 / 60); // a new rep's world clears the turf
    expect(meshes[1].count).toBe(0);
  });

  it('density 0 draws no scuffs', () => {
    const t = new TurfMarks(), w = fake();
    t.density = 0;
    t.follow(at(w, 0, [8, 0, 0]), [], 1 / 60);
    t.follow(at(w, 0.05, [8, 0, 6]), [], 1 / 60);
    expect((t.root.children[1] as unknown as { count: number }).count).toBe(0);
  });
});

describe('uniforms', () => {
  it('every athlete of a team has his own number and name, the same each time', () => {
    for (const team of [0, 1] as const) {
      const ids = Array.from({ length: 12 }, (_, r) => identFor(team, r));
      expect(new Set(ids.map((i) => i.number)).size).toBe(12);
      expect(new Set(ids.map((i) => i.name)).size).toBe(12);
      expect(identFor(team, 3)).toEqual(identFor(team, 3));
    }
    expect(identFor(0, 0).mark).not.toBe(identFor(1, 0).mark);
  });

  it('grass stains build with time down and sliding, up to 1, and are kept per slot', () => {
    clearStains();
    const k = stainKey(0, 2);
    expect(stainOf(k)).toBe(0);
    const a = addStain(k, 2, 0), b = addStain(k, 0, 5);
    expect(b).toBeGreaterThan(a);
    expect(stainOf(stainKey(1, 2))).toBe(0);
    expect(addStain(k, 1000, 1000)).toBe(1);
    clearStains();
  });

  it('decal spots follow the skin\'s own surface: the number on its back, the mark on both sides of the head', () => {
    const torso = [new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2).translate(0, 0.3, 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))];
    const t = skinSpots('thorax', torso);
    expect(t.back!.pos[2]).toBeCloseTo(-0.05 - 0.004); // back face of the box at z = -0.05, 4 mm off it
    expect(t.front!.pos[2]).toBeCloseTo(0.15 + 0.004);
    expect(t.back!.pos[1]).toBeCloseTo(0.3);
    const head = [new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12).translate(0, 0.1, 0), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))];
    const h = skinSpots('head', head);
    expect(h.headL!.pos[0]).toBeGreaterThan(0.09); expect(h.headR!.pos[0]).toBeLessThan(-0.09);
  });
});

describe('crowd', () => {
  it('hops fade out after a big play; a score runs the wave and then it ends', () => {
    const c = new CrowdFx();
    c.react(0.6);
    c.step(0.1);
    expect(c.cheer).toBeGreaterThan(0.5);
    expect(c.wave).toBe(0);
    for (let t = 0; t < CHEER_FADE + 0.2; t += 0.1) c.step(0.1);
    expect(c.cheer).toBe(0);
    c.celebrate();
    c.step(0.1);
    expect(c.cheer).toBeGreaterThan(0.9);
    expect(c.wave).toBe(1);
    for (let t = 0; t < WAVE_TIME + 0.2; t += 0.1) c.step(0.1);
    expect(c.wave).toBe(0);
  });
});

describe('end-of-rep stats', () => {
  /** Two athletes: 0 runs along +z with the ball; contact begins at time `contactAt`. */
  const world = (z: number, vz: number, contact: boolean, carrier = 0) => ({
    ballCarrier: carrier,
    impact: { firstContactTime: contact ? 1 : -1 },
    scene: { athletes: [{ state: { com: [0, 1, z], comVel: [0, 0, vz] } }, { state: { com: [1, 1, 0], comVel: [0, 0, 0] } }] },
  }) as unknown as World;

  it('tracks the fastest speed, and yards only from the first contact along the carrier\'s line', () => {
    const w = world(0, 6, false), s = new RepStats();
    s.step(w, 0);
    expect(s.topSpeed).toBeCloseTo(6);
    const w2 = world(10, 9.5, false);
    (w2 as unknown as { scene: unknown }).scene = { athletes: [{ state: { com: [0, 1, 10], comVel: [0, 0, 9.5] } }] };
    s.step(w2, 0); // a different world: starts over
    expect(s.topSpeed).toBeCloseTo(9.5);
    expect(s.yardsAfterContact).toBe(0);
    const w3 = world(10, 8, false);
    s.step(w3, 0);
    expect(s.yardsAfterContact).toBe(0); // no contact yet
    const w4 = world(10, 8, true);
    s.step(w4, 0);
    expect(s.yardsAfterContact).toBe(0); // contact just began
    w4.scene.athletes[0].state.com[2] = 10 + 3 * YD;
    s.step(w4, 0);
    expect(s.yardsAfterContact).toBeCloseTo(3);
    w4.scene.athletes[0].state.com[2] = 8; // knocked back: never negative
    s.step(w4, 0);
    expect(s.yardsAfterContact).toBe(0);
  });

  it('the hardest hit reads in kN from the 30 ms impulse', () => {
    expect(impulseKN(300)).toBeCloseTo(10);
  });
});

describe('quality levels', () => {
  it('numbers, marks and floodlights from Medium; soft and contact shadows only on High and Ultra', () => {
    const r = (n: keyof typeof PRESETS) => PRESETS[n].render;
    expect(r('potato').decals).toBeFalsy(); expect(r('minimum').decals).toBeFalsy();
    expect(r('medium').decals).toBe(true); expect(r('medium').ao).toBeFalsy();
    expect(r('high').ao).toBe(true); expect(r('ultra').ao).toBe(true);
    expect(FLOODLIGHTS.night.h).toBeGreaterThan(30);
  });
});
