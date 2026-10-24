// Skins line up with the physics: every model node sits on its segment's joint in the rest frame, and posed
// from a live tackle (standard and minimum detail) each node carries its segment's COM and its children's
// joints to where MuJoCo has them.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { AthleteMesh, TEAMS } from '../src/game/render/athleteMesh';
import { bindFrames, boneOffsets, SKINS, template, type Skin } from '../src/game/render/skin';
import { skinSpots } from '../src/game/render/uniform';
import { buildBody, DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { carrierVsTacklerScenario } from '../src/sim/scenarios';
import { World } from '../src/sim/world';

const files = SKINS.filter((s) => s.file);
async function load(s: Skin) {
  const b = readFileSync(`public/${s.file}`);
  const gltf = await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
  return { scene: gltf.scene, tpl: template(gltf.scene, s.look) };
}
const std = buildBody(DEFAULT_ATHLETE, 'standard');
const v = (a: ArrayLike<number>, i = 0) => new THREE.Vector3(a[i], a[i + 1], a[i + 2]);

describe('skins', () => {
  it('lists every exported model, all unlocked, with the owner pick first', () => {
    expect(files.map((s) => s.id).sort()).toEqual(['clay', 'future', 'lowpoly', 'paper', 'rubberhose', 'toon', 'vinyl', 'voxel']);
    expect(files[0].id).toBe(JSON.parse(readFileSync('art/picks.json', 'utf8')).character); // the owner's pick first
    expect(SKINS.every((s) => s.unlocked)).toBe(true);
  });

  it('bone offsets: the bind pose in gives the bind pose out; a turned segment turns its bone about its joint', () => {
    const frames = bindFrames(std.segments);
    // the A-pose swings the left arm out (+x) about +z, the right arm mirrored; the hand follows both turns
    const at = (n: string) => new THREE.Vector3().setFromMatrixPosition(frames.get(n)!);
    expect(at('handL').x).toBeGreaterThan(v(std.segments.find((g) => g.name === 'handL')!.origin).x + 0.1);
    expect(at('handR').x).toBeCloseTo(-at('handL').x, 6);
    const names = [...std.segments.map((g) => g.name), 'tip'];
    const parents = names.map((n) => (n === 'tip' ? names.indexOf('handL') : -1));
    const rnd = (i: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(i, 2 * i, -i));
    const bind = names.map((n, i) => (n === 'tip' ? frames.get('handL')!.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.1, 0))
      : frames.get(n)!.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0.01, 0, 0), rnd(i), new THREE.Vector3(1, 1, 1)))));
    const bones = boneOffsets(names, parents, bind, frames);
    const world = (f: (n: string) => THREE.Matrix4) => { // segment bones ride f(segment), others their parent bone
      const out: THREE.Matrix4[] = [];
      bones.forEach((b, i) => out.push((b.parent < 0 ? f(b.name) : out[b.parent]).clone().multiply(b.off)));
      return out;
    };
    world((n) => frames.get(n)!).forEach((m, i) => expect(m.equals(bind[i]) || m.toArray().every((x, k) => Math.abs(x - bind[i].elements[k]) < 1e-9), names[i]).toBe(true));
    // turn the left forearm 90° about x at its joint: its bone (and the hand, and the tip) turn with it
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), j = at('forearmL');
    const turn = new THREE.Matrix4().makeTranslation(j.x, j.y, j.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-j.x, -j.y, -j.z));
    const moved = new Set(['forearmL', 'handL']);
    const posed = world((n) => (moved.has(n) ? turn.clone().multiply(frames.get(n)!) : frames.get(n)!));
    names.forEach((n, i) => {
      const want = moved.has(n) || n === 'tip' ? turn.clone().multiply(bind[i]) : bind[i];
      expect(posed[i].toArray().every((x, k) => Math.abs(x - want.elements[k]) < 1e-9), n).toBe(true);
    });
  });

  it.each(files.map((s) => [s.id, s] as const))('%s: nodes on the rest-frame joints, meshes over their segments', async (_id, s) => {
    const { scene, tpl } = await load(s);
    expect([...tpl.parts.keys()].sort()).toEqual(std.segments.map((g) => g.name).sort());
    if (tpl.rig) {
      // rigged: every segment's bone starts on its joint (the A-posed one the file is bound in, checked by
      // art/tools/check-skinned.ts), and the face/decal surfaces sit over the head and the chest
      for (const b of tpl.rig.bones) expect(new THREE.Vector3().setFromMatrixPosition(b.off).length(), b.name).toBeLessThan(0.02);
      for (const n of ['head', 'thorax']) {
        const box = new THREE.Box3();
        for (const m of tpl.parts.get(n)!) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); }
        expect(box.isEmpty(), n).toBe(false);
        expect(Math.abs(box.getCenter(new THREE.Vector3()).x), n).toBeLessThan(0.01); // rest frame about the segment origin
        expect(box.max.y, n).toBeGreaterThan(0.05);
      }
      return;
    }
    for (const seg of std.segments) {
      const node = scene.getObjectByName(seg.name)!;
      // rest frame = the file's node translations with the A-pose rotations dropped
      const p = new THREE.Vector3();
      for (let o: THREE.Object3D | null = node; o && o !== scene; o = o.parent) p.add(o.position);
      expect(p.distanceTo(v(seg.origin)), seg.name).toBeLessThan(1e-3);
      // mesh bounds (rest frame) overlap the segment's collision shapes: catches mirrored or rotated mesh data
      const mesh = new THREE.Box3();
      for (const m of tpl.parts.get(seg.name)!) { m.geometry.computeBoundingBox(); mesh.union(m.geometry.boundingBox!); }
      mesh.translate(p);
      const body = new THREE.Box3(); // centres and capsule ends of the collision shapes
      for (const g of seg.geoms) for (const q of g.fromto ?? [g.pos!]) body.expandByPoint(v(q));
      const c = mesh.getCenter(new THREE.Vector3()), cb = body.getCenter(new THREE.Vector3());
      const msg = `${s.id} ${seg.name} mesh centre ${c.toArray().map((x) => x.toFixed(3))} vs body ${cb.toArray().map((x) => x.toFixed(3))}`;
      const r = Math.max(...seg.geoms.flatMap((g) => g.size));
      expect(mesh.intersectsBox(body.clone().expandByScalar(r)) && Math.abs(c.x - cb.x) < 0.03, msg).toBe(true);
      // stylised heads (1.5-1.95x, growing up from the neck) and cartoon shoes are deliberately off-centre
      if (!/^(head|toes)/.test(seg.name)) expect(c.distanceTo(cb), msg).toBeLessThan(0.07);
    }
  });

  it.each(['standard', 'minimum'] as const)('posed from a %s-detail tackle, every node follows MuJoCo', async (detail) => {
    const { tpl } = await load(files[0]);
    // the carrier is not the reference athlete, so the stature scaling is exercised too
    const w = await World.create(mujocoEngine, carrierVsTacklerScenario({ hz: 240, iterations: 30, detail }, { carrier: { height: 1.8, mass: 98, strength: 1, speed: 1 } }).setup);
    for (let i = 0; i < Math.round(2.2 / w.dt); i++) w.step();
    expect(w.impact.firstContactTime, 'the athletes collided').toBeGreaterThan(0);
    expect(w.scene.stats().instabilities).toBe(0);
    w.athletes.forEach((a, ai) => {
      const s = w.scene.athletes[ai].state, plan = a.plan;
      const m = new AthleteMesh(plan, TEAMS[a.setup.team], 'low', tpl);
      expect(m.parts.length).toBe(21);
      m.pose(s.segPos, s.segQuat);
      m.root.updateMatrixWorld(true);
      const rest = new Map(buildBody(plan.params, 'standard').segments.map((g) => [g.name, v(g.origin)]));
      const k = plan.params.height / DEFAULT_ATHLETE.height;
      const names = [...tpl.parts.keys()];
      m.parts.forEach(({ node, seg }, pi) => {
        const name = names[pi], o = rest.get(name)!;
        const at = (p: THREE.Vector3) => p.clone().sub(o).divideScalar(k).applyMatrix4(node.matrixWorld); // rest-frame point → world via the node
        const S = plan.segments[seg];
        expect(at(v(S.com)).distanceTo(v(s.segCom, 3 * seg)), `${name} on ${S.name}: COM`).toBeLessThan(1e-3);
        plan.segments.forEach((c, ci) => {
          if (c.parent !== S.name) return;
          expect(at(v(c.origin)).distanceTo(v(s.segPos, 3 * ci)), `${name} on ${S.name}: joint of ${c.name}`).toBeLessThan(0.01);
        });
      });
    });
    w.destroy();
  });

  it('a rigged skin (future): bound pose in gives the file\'s bind pose out; in a tackle every bone sits on its segment', async () => {
    const s = files.find((f) => f.id === 'future')!;
    const tpl = { ...(await load(s)).tpl, id: s.id }; // the id picks the face style, as loadSkin does
    expect(tpl.rig?.bones.length).toBe(21);
    // physics in the bind pose (reference athlete): every bone matrix is the file's own bind matrix
    const plan = buildBody(DEFAULT_ATHLETE, 'standard'), frames = bindFrames(plan.segments);
    const pos: number[] = [], quat: number[] = [];
    for (const g of plan.segments) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      frames.get(g.name)!.decompose(p, q, new THREE.Vector3());
      pos.push(...p.toArray()); quat.push(q.x, q.y, q.z, q.w);
    }
    const m = new AthleteMesh(plan, TEAMS[0], 'low', tpl);
    m.pose(pos, quat);
    m.root.updateMatrixWorld(true);
    const bones = (m as unknown as { skeleton: THREE.Skeleton }).skeleton.bones;
    bones.forEach((b, i) => {
      const want = tpl.rig!.inverses[i].clone().invert();
      expect(b.matrixWorld.toArray().every((x, k) => Math.abs(x - want.elements[k]) < 1e-5), b.name).toBe(true);
    });
    expect(m.mouth && m.brows).toBeTruthy();
    const chest = skinSpots('thorax', tpl.parts.get('thorax')!), head = skinSpots('head', tpl.parts.get('head')!);
    expect([chest.front, chest.back, head.headL, head.headR].every(Boolean)).toBe(true);
    m.dispose();
    // a live tackle by a shorter, heavier carrier: each bone on its segment's origin (fused ones at minimum detail too)
    for (const detail of ['standard', 'minimum'] as const) {
      const w = await World.create(mujocoEngine, carrierVsTacklerScenario({ hz: 240, iterations: 30, detail }, { carrier: { height: 1.8, mass: 98, strength: 1, speed: 1 } }).setup);
      for (let i = 0; i < Math.round(2.2 / w.dt); i++) w.step();
      expect(w.impact.firstContactTime).toBeGreaterThan(0);
      w.athletes.forEach((a, ai) => {
        const st = w.scene.athletes[ai].state, am = new AthleteMesh(a.plan, TEAMS[a.setup.team], 'low', tpl);
        am.pose(st.segPos, st.segQuat);
        am.root.updateMatrixWorld(true);
        const index = new Map(a.plan.segments.map((g, i) => [g.name, i]));
        for (const b of (am as unknown as { skeleton: THREE.Skeleton }).skeleton.bones) {
          const i = index.get(b.name);
          // fused away (rides its parent, as the rigid-skin test checks) or the fused neck+head, which keeps the neck's origin
          if (i === undefined || (detail === 'minimum' && b.name === 'head')) continue;
          expect(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).distanceTo(v(st.segPos, 3 * i)), `${detail} ${b.name}`).toBeLessThan(0.005);
        }
        am.dispose();
      });
      w.destroy();
    }
  });
});
