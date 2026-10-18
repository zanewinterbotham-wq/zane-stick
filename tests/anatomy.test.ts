import { describe, expect, it } from 'vitest';
import { buildBody, DEFAULT_ATHLETE, totalMass, wholeCom, wholeInertia } from '../src/sim/anatomy/body';
import { DE_LEVA, JOINTS } from '../src/sim/anatomy/data';
import { EQUIPMENT } from '../src/sim/anatomy/equipment';
import { validInertia } from '../src/sim/anatomy/inertia';

const equipMass = EQUIPMENT.helmet.mass + EQUIPMENT.pads.mass + EQUIPMENT.jersey.mass + 2 * EQUIPMENT.cleats.mass;

describe('de Leva table', () => {
  it('segment mass fractions sum to 100 %', () => {
    const d = DE_LEVA;
    const sum = d.head.mass + d.trunk.mass + 2 * (d.upperArm.mass + d.forearm.mass + d.hand.mass + d.thigh.mass + d.shank.mass + d.foot.mass);
    expect(sum).toBeCloseTo(100, 6);
    expect(d.upt.mass + d.mpt.mass + d.lpt.mass).toBeCloseTo(d.trunk.mass, 6);
  });
});

describe.each(['standard', 'minimum'] as const)('%s body', (detail) => {
  const p = buildBody(DEFAULT_ATHLETE, detail);
  it('has the expected segment count', () => expect(p.segments.length).toBe(detail === 'standard' ? 21 : 13));
  it('total mass = body + equipment', () => expect(totalMass(p)).toBeCloseTo(DEFAULT_ATHLETE.mass + equipMass, 6));
  it('every segment has positive mass and a valid inertia', () => {
    for (const s of p.segments) {
      expect(s.mass, s.name).toBeGreaterThan(0);
      expect(validInertia(s.inertia), s.name).toBe(true);
    }
  });
  it('whole-body COM is near 56 % of stature, centred', () => {
    const c = wholeCom(p);
    expect(c[1] / DEFAULT_ATHLETE.height).toBeGreaterThan(0.54);
    expect(c[1] / DEFAULT_ATHLETE.height).toBeLessThan(0.60);
    expect(Math.abs(c[0])).toBeLessThan(1e-9);
  });
  it('every joint connects existing segments and has sane ranges', () => {
    const names = new Set(p.segments.map((s) => s.name));
    for (const j of p.joints) {
      expect(names.has(j.parent), j.name).toBe(true);
      expect(names.has(j.child), j.name).toBe(true);
      for (const d of j.dofs) {
        expect(d.range[0]).toBeLessThan(0.0001);
        expect(d.range[1]).toBeGreaterThan(-0.0001);
        expect(d.tPos).toBeGreaterThan(0);
        expect(d.tNeg).toBeGreaterThan(0);
      }
    }
    expect(p.joints.length).toBe(p.segments.length - 1); // a tree
  });
});

describe('detail levels preserve mass properties', () => {
  const s = buildBody(DEFAULT_ATHLETE, 'standard'), m = buildBody(DEFAULT_ATHLETE, 'minimum');
  it('mass, COM and whole-body inertia match within 0.5 %', () => {
    expect(totalMass(m)).toBeCloseTo(totalMass(s), 9);
    const cs = wholeCom(s), cm = wholeCom(m);
    for (let i = 0; i < 3; i++) expect(Math.abs(cs[i] - cm[i])).toBeLessThan(1e-9);
    const Is = wholeInertia(s), Im = wholeInertia(m);
    for (const i of [0, 4, 8]) expect(Math.abs(Im[i] - Is[i]) / Is[i]).toBeLessThan(0.005);
  });
  it('minimum detail keeps the strength of surviving joints and widens ranges of merged chains', () => {
    const lumS = s.joints.find((j) => j.name === 'lumbar')!, thoS = s.joints.find((j) => j.name === 'thoracic')!;
    const lumM = m.joints.find((j) => j.name === 'lumbar')!;
    expect(lumM.dofs[0].tPos).toBe(lumS.dofs[0].tPos);
    expect(lumM.dofs[0].range[1]).toBeCloseTo(lumS.dofs[0].range[1] + thoS.dofs[0].range[1], 9);
  });
  it('minimum detail fuses de Leva segments back exactly (trunk = MPT + UPT + pads + jersey)', () => {
    const trunk = m.segments.find((x) => x.name === 'trunk')!;
    const expected = ((DE_LEVA.mpt.mass + DE_LEVA.upt.mass) / 100) * DEFAULT_ATHLETE.mass + EQUIPMENT.pads.mass + EQUIPMENT.jersey.mass;
    expect(trunk.mass).toBeCloseTo(expected, 9);
  });
});

describe('scaling', () => {
  it('segment lengths scale with height and masses with body mass', () => {
    const a = buildBody({ ...DEFAULT_ATHLETE, height: 1.7, mass: 80 }), b = buildBody({ ...DEFAULT_ATHLETE, height: 1.9, mass: 120 });
    const thighLen = (p: typeof a) => { const t = p.segments.find((x) => x.name === 'thighL')!, k = p.segments.find((x) => x.name === 'shankL')!; return t.origin[1] - k.origin[1]; };
    expect(thighLen(b) / thighLen(a)).toBeCloseTo(1.9 / 1.7, 6);
    expect(b.segments.find((x) => x.name === 'thighL')!.tissueMass / a.segments.find((x) => x.name === 'thighL')!.tissueMass).toBeCloseTo(120 / 80, 6);
  });
  it('strength slider scales torques, never anything else', () => {
    const a = buildBody(DEFAULT_ATHLETE), b = buildBody({ ...DEFAULT_ATHLETE, strength: 1.2 });
    expect(b.joints[0].dofs[0].tPos / a.joints[0].dofs[0].tPos).toBeCloseTo(1.2, 9);
    expect(totalMass(b)).toBeCloseTo(totalMass(a), 9);
  });
  it('every joint in the data table is used', () => {
    const p = buildBody(DEFAULT_ATHLETE);
    for (const j of JOINTS) expect(p.joints.some((x) => x.name.replace(/[LR]$/, '') === j.name), j.name).toBe(true);
  });
});

import { forceVelocity, MuscleSet } from '../src/sim/muscles';
describe('muscles', () => {
  it('torque–velocity: 1 isometric, 0 at max speed, decreasing when shortening, > 1 when lengthening', () => {
    expect(forceVelocity(0)).toBeCloseTo(1, 9);
    expect(forceVelocity(1)).toBe(0);
    expect(forceVelocity(0.5)).toBeLessThan(forceVelocity(0.2));
    expect(forceVelocity(-0.5)).toBeGreaterThan(1);
    expect(forceVelocity(-5)).toBeLessThanOrEqual(1.3 + 1e-9);
  });
  it('clamps controller requests to the available torque', () => {
    const ms = new MuscleSet(buildBody(DEFAULT_ATHLETE));
    const i = ms.index('kneeL.flex');
    const t = { q: new Float64Array(ms.n), qd: new Float64Array(ms.n), kp: new Float64Array(ms.n), kd: new Float64Array(ms.n), tff: new Float64Array(ms.n).fill(1e6) };
    const q = new Float64Array(ms.n), qd = new Float64Array(ms.n);
    ms.compute(t, q, qd);
    expect(ms.torque[i]).toBeCloseTo(ms.tPos[i], 6);
    expect(ms.effort[i]).toBeCloseTo(1, 6);
    qd[i] = ms.wMax[i] * 0.5; // moving fast in the pushing direction
    ms.compute(t, q, qd);
    expect(ms.torque[i]).toBeLessThan(0.25 * ms.tPos[i]);
  });
  it('effective inertia is larger at the hip than the ankle', () => {
    const ms = new MuscleSet(buildBody(DEFAULT_ATHLETE));
    expect(ms.ieff[ms.index('hipL.flex')]).toBeGreaterThan(5 * ms.ieff[ms.index('ankleL.dorsi')]);
  });
});
