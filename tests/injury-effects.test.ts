// Injury effects (game side, design §6.6): every style sprays and lands, bones pin to the broken segment, comic stars
// circle a knocked-out head, a new rep clears the turf; the picks file keeps the owner's effect styles.
import { describe, expect, it } from 'vitest';
import { InjuryEffects, STYLES } from '../src/game/render/effects';
import type { InjuryEvent } from '../src/sim/injury';
import type { World } from '../src/sim/world';
import { emptyPicks, validate } from '../tools/picker/picks';

const pose = () => ({ pos: [0, 0.5, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] });
const inst = (fx: InjuryEffects) => fx.root.children.filter((c) => (c as { isInstancedMesh?: boolean }).isInstancedMesh) as unknown as { count: number }[];

describe('injury effects', () => {
  it('each style bursts, lands on the turf (splats unless bloodless) and pins its bone to the broken segment', () => {
    for (const st of STYLES) {
      const fx = new InjuryEffects(st), [parts, decals] = inst(fx);
      fx.break([0, 0.5, 0], pose, 1);
      fx.step(1 / 60);
      expect(parts.count, st.id).toBeGreaterThan(0);
      for (let i = 0; i < 300; i++) fx.step(1 / 60);
      expect(parts.count, st.id).toBe(0); // every drop has landed (drips have stopped)
      expect(decals.count > 0, st.id).toBe(st.decal !== 'none');
      const bone = fx.root.children.find((c) => c.type === 'Group')!;
      expect(bone.position.y, st.id).toBeCloseTo(0.5);
      expect(bone.children[0].children.length > 0, st.id).toBe(st.bone !== 'none');
    }
  });

  it('comic stars circle a knocked-out head; a new world clears everything', () => {
    const fx = new InjuryEffects(STYLES.find((s) => s.id === 'comic'));
    const ko: InjuryEvent = { athlete: 0, kind: 'ko', joint: 'head', what: 'ko', seg: 'head', parentSeg: 'neck', pos: [0, 1.7, 0], load: 12, time: 1 };
    const world = (time: number, injuries: InjuryEvent[]) => ({
      time, injuries, athletes: [{ segIndex: new Map([['head', 0]]) }],
      scene: { athletes: [{ state: { segPos: new Float64Array([0, 1.7, 0]), segQuat: new Float64Array([0, 0, 0, 1]) } }] },
    }) as unknown as World;
    const w = world(1, [ko]);
    fx.follow(w); fx.follow(w);
    const stars = fx.root.children.filter((c) => c.type === 'Group');
    expect(stars).toHaveLength(1); // one knockout, one ring of stars, however often the world is followed
    w.time = 1.5; fx.follow(w);
    expect(stars[0].children[0].position.y).toBeGreaterThan(1.8);
    fx.follow(world(0, []));
    expect(fx.root.children.filter((c) => c.type === 'Group')).toHaveLength(0);
  });

  it('the picks file keeps chosen effect styles and rejects bad ones', () => {
    expect(validate({ ...emptyPicks(), effects: ['voxel', 'comic'] })).toEqual({ ok: true, picks: { ...emptyPicks(), effects: ['voxel', 'comic'] } });
    expect(validate({ ...emptyPicks(), effects: [] })).toEqual({ ok: true, picks: emptyPicks() });
    const bad = validate({ ...emptyPicks(), effects: ['voxel', 'voxel'] });
    expect(bad.ok ? [] : bad.errors).toEqual(['effects must be a list of distinct effect style ids']);
  });
});
