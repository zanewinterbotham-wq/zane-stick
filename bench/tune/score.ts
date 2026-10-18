// Score one gain set with the tuning objective (lower is better):
//   npx tsx bench/tune/score.ts '{"clearance":0.12}'   (or a gains JSON file)   [--avg]
// The objective is chaotic (tiny gain changes flip whole parts), so --avg reports the mean over six small
// perturbations of unrelated gains; compare controller changes with --avg.
import { evaluate } from './evaluate';
import { readFileSync } from 'node:fs';
const arg = process.argv.slice(2).find((a) => a !== '--avg') ?? '{}';
const g = arg.endsWith('.json') ? JSON.parse(readFileSync(arg, 'utf8')).gains : JSON.parse(arg);
const P = process.argv.includes('--avg')
  ? [{}, { swingWn: 28 }, { swingWn: 32 }, { stanceKneeBend: 0.11 }, { stanceKneeBend: 0.13 }, { dampT: 0.032 }]
  : [{}];
const sum: Record<string, number> = {};
let tot = 0;
for (const p of P) {
  const r = await evaluate({ ...g, ...p });
  tot += r.score / P.length;
  for (const [k, v] of Object.entries(r.parts)) sum[k] = (sum[k] ?? 0) + v / P.length;
}
console.log(arg.slice(0, 40), tot.toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, +v.toFixed(1)]))));
