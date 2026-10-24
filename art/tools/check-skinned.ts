// Checks every skinned model in art/models/<id>/<id>.glb: one joint per physics segment (named after it), joint
// hierarchy = physics parents, joints within 2 cm of the physics joint positions (A-pose arms: joint-to-joint lengths),
// all vertices weighted, 15k-30k triangles, file under 3 MB. Run: npx tsx art/tools/check-skinned.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

type Node = { name: string; children?: number[]; translation?: number[]; rotation?: number[]; skin?: number };
const body = JSON.parse(readFileSync(join(here, 'body.json'), 'utf8'));
const seg = new Map<string, { parent: string | null; origin: number[] }>(body.segments.map((s: any) => [s.name, s]));
const dir = join(here, '..', 'models');
const TOL = 0.02;

const rot = (q: number[], v: number[]) => { // rotate v by unit quaternion q = [x, y, z, w]
  const [x, y, z, w] = q, [a, b, c] = v;
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const mul = (p: number[], q: number[]) => [
  p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1], p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
  p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3], p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const COMP: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const SIZE: Record<string, number> = { SCALAR: 1, VEC4: 4 };

let bad = 0, models = 0;
const fail = (msg: string) => { bad++; console.log('  FAIL ' + msg); };
for (const id of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
  const file = join(dir, id, id + '.glb');
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  if (!json.skins?.length) continue; // props (e.g. the football) are not skinned
  models++;
  const bin = buf.subarray(20 + jlen + 8);
  const nodes: Node[] = json.nodes;
  const joints: number[] = json.skins[0].joints;
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const world = new Map<number, { p: number[]; q: number[] }>();
  const W = (i: number): { p: number[]; q: number[] } => {
    if (world.has(i)) return world.get(i)!;
    const n = nodes[i], t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1];
    const par = parentOf.has(i) ? W(parentOf.get(i)!) : { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const w = { p: rot(par.q, t).map((v, k) => v + par.p[k]), q: mul(par.q, r) };
    world.set(i, w);
    return w;
  };
  const read = (ai: number) => { // accessor -> number[][] (tuples)
    const a = json.accessors[ai], v = json.bufferViews[a.bufferView], n = SIZE[a.type], c = COMP[a.componentType];
    const stride = v.byteStride ?? n * c, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const get = (o: number) => (c === 1 ? bin.readUInt8(o) : c === 2 ? bin.readUInt16LE(o) : a.componentType === 5126 ? bin.readFloatLE(o) : bin.readUInt32LE(o));
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: n }, (_, k) => get(base + i * stride + k * c)));
  };
  let tris = 0, unweighted = 0;
  for (const m of json.meshes) for (const p of m.primitives) {
    tris += (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3;
    if (p.attributes.WEIGHTS_0 === undefined) { fail(`${id}: primitive without skin weights`); continue; }
    unweighted += read(p.attributes.WEIGHTS_0).filter((w) => w.reduce((s, x) => s + x, 0) < 0.99).length;
  }
  console.log(`${id}: ${joints.length} joints, ${tris} triangles, ${(buf.length / 1024).toFixed(1)} KB, materials ${json.materials.map((m: any) => m.name).join(' ')}`);
  if (buf.length > 3 * 1024 * 1024) fail(`${id} is ${buf.length} bytes (> 3 MB)`);
  if (tris < 15000 || tris > 30000) fail(`${id}: ${tris} triangles (want 15k-30k)`);
  if (unweighted) fail(`${id}: ${unweighted} vertices with weights summing below 1`);
  for (const [name, s] of seg) {
    const i = joints.find((j) => nodes[j].name === name);
    if (i === undefined) { fail(`${id}: no joint ${name}`); continue; }
    const pi = parentOf.get(i);
    const pname = pi === undefined || !joints.includes(pi) ? null : nodes[pi].name;
    if (pname !== s.parent) fail(`${id}: ${name} parent ${pname} != ${s.parent}`);
    const p = W(i).p;
    if (/^(forearm|hand)/.test(name)) { // below the A-posed shoulder: only joint-to-joint lengths are fixed
      const e = Math.abs(dist(p, W(pi!).p) - dist(s.origin, seg.get(s.parent!)!.origin));
      if (e > TOL) fail(`${id}: ${name} bone length off by ${e.toFixed(4)} m`);
    } else if (dist(p, s.origin) > TOL) fail(`${id}: ${name} at ${p.map((v) => v.toFixed(3))} != ${s.origin}`);
  }
}
console.log(bad ? `${bad} failures` : `all ${models} skinned models OK`);
process.exit(bad || !models ? 1 : 0);
