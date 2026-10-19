// CPU profile helper: top self-time functions of one scene (node --cpu-prof writes the .cpuprofile).
//   npx tsx bench/perf/profile.ts <file.cpuprofile> [n]
import { readFileSync } from 'node:fs';

const prof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const self = new Map<string, number>();
const byId = new Map<number, any>(prof.nodes.map((n: any) => [n.id, n]));
const dt = new Map<number, number>();
prof.samples.forEach((id: number, i: number) => dt.set(id, (dt.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0)));
let total = 0;
for (const [id, t] of dt) {
  const n = byId.get(id), cf = n.callFrame, key = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + t); total += t;
}
for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] ?? 40))) console.log(`${(100 * t / total).toFixed(1).padStart(5)}%  ${k}`);
