// Checks every exported character: one node per physics segment, hierarchy = physics parents, node origins at the
// physics joint positions (A-pose arms: the joint-to-joint lengths), mesh in metres, file well under 300 KB.
// Run: npx tsx art/tools/check-glb.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

type Node = { name: string; children?: number[]; translation?: number[]; rotation?: number[]; mesh?: number };
const body = JSON.parse(readFileSync(join(here, 'body.json'), 'utf8'));
const seg = new Map<string, { parent: string | null; origin: number[] }>(body.segments.map((s: any) => [s.name, s]));
const dir = join(here, '..', 'characters');

const rot = (q: number[], v: number[]) => { // rotate v by unit quaternion q = [x, y, z, w]
  const [x, y, z, w] = q, [a, b, c] = v;
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const mul = (p: number[], q: number[]) => [
  p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1], p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
  p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3], p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let bad = 0;
const fail = (msg: string) => { bad++; console.log('  FAIL ' + msg); };
for (const style of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
  const file = join(dir, style, style + '.glb');
  const buf = readFileSync(file);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const nodes: Node[] = json.nodes;
  console.log(`${style}: ${nodes.length} nodes, ${(buf.length / 1024).toFixed(1)} KB, materials ${json.materials.map((m: any) => m.name).join(' ')}`);
  if (buf.length > 300 * 1024) fail(`${style} is ${buf.length} bytes`);
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const world = new Map<number, { p: number[]; q: number[] }>();
  const W = (i: number): { p: number[]; q: number[] } => {
    if (world.has(i)) return world.get(i)!;
    const n = nodes[i], t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1];
    const par = parentOf.has(i) ? W(parentOf.get(i)!) : { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const wp = rot(par.q, t).map((v, k) => v + par.p[k]);
    const w = { p: wp, q: mul(par.q, r) };
    world.set(i, w);
    return w;
  };
  for (const [name, s] of seg) {
    const i = nodes.findIndex((n) => n.name === name);
    if (i < 0) { fail(`${style}: no node ${name}`); continue; }
    if (nodes[i].mesh === undefined) fail(`${style}: ${name} has no mesh`);
    const pi = parentOf.get(i);
    if ((pi === undefined ? null : nodes[pi].name) !== s.parent) fail(`${style}: ${name} parent ${pi === undefined ? null : nodes[pi].name} != ${s.parent}`);
    const p = W(i).p;
    if (/^(forearm|hand)/.test(name)) { // below the A-posed shoulder: only joint-to-joint lengths are fixed
      const e = Math.abs(dist(p, W(pi!).p) - dist(s.origin, seg.get(s.parent!)!.origin));
      if (e > 1e-3) fail(`${style}: ${name} bone length off by ${e.toFixed(4)} m`);
    } else if (dist(p, s.origin) > 1e-3) fail(`${style}: ${name} at ${p.map((v) => v.toFixed(3))} != ${s.origin}`);
  }
}
console.log(bad ? `${bad} failures` : 'all characters OK');
process.exit(bad ? 1 : 0);
