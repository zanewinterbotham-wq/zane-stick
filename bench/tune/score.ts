// Score one gain set with the tuning objective: npx tsx bench/tune/score.ts '{"clearance":0.12}' (or a gains JSON file). Lower is better.
import { evaluate } from './evaluate';
import { readFileSync } from 'node:fs';
const arg = process.argv[2] ?? '{}';
const g = arg.endsWith('.json') ? JSON.parse(readFileSync(arg, 'utf8')).gains : JSON.parse(arg);
const t = performance.now();
const r = await evaluate(g);
console.log(arg.slice(0, 40), r.score.toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, +v.toFixed(1)]))), ((performance.now() - t) / 1000).toFixed(0) + ' s');
