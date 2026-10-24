import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FreeCamera } from '../src/game/camera';
import { Playback, ReplayBuffer } from '../src/game/replay';

const push = (b: ReplayBuffer, t: number) => b.push(t, [[t, 0, 0], [t]], [[0, 0, 0, 1]], [t]);

describe('replay buffer', () => {
  it('keeps the newest frames in a ring, oldest first, one per 1/hz', () => {
    const b = new ReplayBuffer(1, 10); // 10 frames
    expect(b.cap).toBe(10);
    expect(push(b, 0)).toBe(true);
    expect(push(b, 0.05)).toBe(false); // too soon
    expect(push(b, 0)).toBe(false);    // time stood still (paused)
    for (let i = 1; i < 25; i++) push(b, i / 10);
    expect(b.length).toBe(10);
    expect(b.start).toBeCloseTo(1.5);
    expect(b.end).toBeCloseTo(2.4);
    for (let i = 0; i < 10; i++) expect(b.at(i).t).toBeCloseTo(1.5 + i / 10);
    expect([...b.at(9).pos]).toEqual([expect.closeTo(2.4), 0, 0, expect.closeTo(2.4)]);
    b.clear();
    expect(b.length).toBe(0);
  });

  it('locates the frames around a time, clamped to the ends', () => {
    const b = new ReplayBuffer(1, 10);
    for (let i = 0; i < 15; i++) push(b, i / 10); // holds 0.5 .. 1.4
    const l = b.locate(0.93);
    expect(b.at(l.i).t).toBeCloseTo(0.9);
    expect(l.alpha).toBeCloseTo(0.3);
    expect(b.locate(0)).toEqual({ i: 0, alpha: 0 });
    expect(b.locate(9)).toEqual({ i: 8, alpha: 1 });
  });

  it('plays back from 8 s before the end, holds at the end, restarts on play', () => {
    const b = new ReplayBuffer(15, 60);
    for (let i = 0; i <= 600; i++) push(b, i / 60); // 10 s
    const p = new Playback(b);
    expect(p.t).toBeCloseTo(2);
    p.step(1); expect(p.t).toBeCloseTo(3);
    p.speed = 0.25; p.step(1); expect(p.t).toBeCloseTo(3.25);
    p.scrub(-99); expect(p.t).toBeCloseTo(b.start);
    p.speed = 1; p.step(20);
    expect([p.t, p.paused]).toEqual([b.end, true]);
    p.toggle();
    expect([p.t, p.paused]).toEqual([2, false]);
    p.toggle(); p.step(1);
    expect(p.t).toBe(2); // paused
  });
});

describe('free camera', () => {
  it('starts looking where the camera looks and flies along the view', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(1, 3, -5);
    cam.lookAt(1, 1, 0);
    cam.updateMatrixWorld();
    const f = new FreeCamera(), d0 = cam.getWorldDirection(new THREE.Vector3());
    f.from(cam);
    f.update(cam, 0, 0, 0, 0.016);
    expect(cam.position.toArray()).toEqual([1, 3, -5]);
    expect(cam.getWorldDirection(new THREE.Vector3()).distanceTo(d0)).toBeLessThan(1e-6);
    f.speed = 2;
    f.update(cam, 0, 1, 0, 1); // 2 m forward
    expect(cam.position.clone().sub(new THREE.Vector3(1, 3, -5)).normalize().distanceTo(d0)).toBeLessThan(1e-6);
    f.update(cam, 0, 0, -1, 100); // never below the turf
    expect(cam.position.y).toBeCloseTo(0.05);
  });
});
