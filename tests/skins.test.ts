// Skins line up with the physics: every model node sits on its segment's joint in the rest frame, and posed
// from a live tackle (standard and minimum detail) each node carries its segment's COM and its children's
// joints to where MuJoCo has them.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { AthleteMesh, TEAMS } from '../src/game/render/athleteMesh';
import { SKINS, template, type Skin } from '../src/game/render/skin';
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

  it.each(files.map((s) => [s.id, s] as const))('%s: nodes on the rest-frame joints, meshes over their segments', async (_id, s) => {
    const { scene, tpl } = await load(s);
    expect([...tpl.parts.keys()].sort()).toEqual(std.segments.map((g) => g.name).sort());
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
});
