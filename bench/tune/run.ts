// CMA-ES tuning of the hand-built controller's gains, evaluated in parallel worker threads.
//   npx tsx bench/tune/run.ts [generations] [workers]
// Parameters are searched in log space around DEFAULT_GAINS (multiplicative steps).
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { DEFAULT_GAINS, type Gains } from '../../src/sim/control/hand';
import { CMAES } from './cmaes';

const gens = +(process.argv[2] ?? 60);
const nWorkers = +(process.argv[3] ?? Math.max(1, cpus().length - 1));
const keys = Object.keys(DEFAULT_GAINS) as (keyof Gains)[];
const startFile = 'bench/out/gains-best.json';
const start: Gains = existsSync(startFile) ? { ...DEFAULT_GAINS, ...JSON.parse(readFileSync(startFile, 'utf8')).gains } : DEFAULT_GAINS;
// every gain stays within 1/4x..4x of its starting value (log-space clamp)
const toGains = (x: number[]) => Object.fromEntries(keys.map((k, i) => [k, start[k] * Math.exp(Math.max(-1.4, Math.min(1.4, x[i])))])) as unknown as Gains;

const workers = Array.from({ length: nWorkers }, () => new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] }));
let nextId = 0;
const pending = new Map<number, (v: { score: number; parts: Record<string, number> }) => void>();
workers.forEach((w) => w.on('message', (m: { id: number; score: number; parts: Record<string, number> }) => { pending.get(m.id)!(m); pending.delete(m.id); }));
const queue: (() => void)[] = [];
const free = [...workers];
function evalGains(g: Gains): Promise<{ score: number; parts: Record<string, number> }> {
  return new Promise((res) => {
    const go = () => {
      const w = free.pop()!, id = nextId++;
      pending.set(id, (v) => { free.push(w); res(v); queue.shift()?.(); });
      w.postMessage({ id, gains: g });
    };
    if (free.length) go(); else queue.push(go);
  });
}

let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const es = new CMAES(new Array(keys.length).fill(0), 0.25, +(process.argv[4] ?? Math.max(12, nWorkers)), rand);
const base = await evalGains(start);
console.log('start score', base.score.toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(base.parts).map(([k, v]) => [k, +v.toFixed(2)]))));
let best = { score: base.score, gains: start, parts: base.parts };
mkdirSync('bench/out', { recursive: true });
for (let g = 0; g < gens; g++) {
  const xs = es.ask();
  const rs = await Promise.all(xs.map((x) => evalGains(toGains(x))));
  es.tell(xs, rs.map((r) => r.score));
  const i = rs.reduce((bi, r, k) => (r.score < rs[bi].score ? k : bi), 0);
  if (rs[i].score < best.score) {
    best = { score: rs[i].score, gains: toGains(xs[i]), parts: rs[i].parts };
    writeFileSync(startFile, JSON.stringify(best, null, 2));
  }
  console.log(`gen ${g} best ${rs[i].score.toFixed(2)} overall ${best.score.toFixed(2)} sigma ${es.sigma.toFixed(3)}`, JSON.stringify(Object.fromEntries(Object.entries(best.parts).map(([k, v]) => [k, +v.toFixed(2)]))));
}
console.log('BEST', JSON.stringify(best.gains));
await Promise.all(workers.map((w) => w.terminate()));
