// Node engine comparison: npm run bench:engines
import { mkdirSync, writeFileSync } from 'node:fs';
import { rapierEngine } from './rapier';
import { joltEngine } from './jolt';
import { mujocoEngine } from './mujoco';
import type { BenchEngine } from './common';
import { collision, determinism, features, perf, torqueStability } from './scenarios';

const withIters = (e: BenchEngine, n: number): BenchEngine => ({ ...e, name: `${e.name}-it${n}`, create: (o) => e.create({ ...o, iterations: n }) });
const engines = [
  rapierEngine('det', 'impulse'), withIters(rapierEngine('det', 'impulse'), 8), rapierEngine('det', 'multibody'), rapierEngine('std', 'impulse'),
  joltEngine, mujocoEngine(), mujocoEngine('damped'), mujocoEngine('armature'),
];
const only = process.argv[2];
const out: Record<string, unknown> = {};

for (const e of engines) {
  if (only && !e.name.includes(only)) continue;
  await e.init();
  const r: Record<string, unknown> = { notes: e.notes };
  const t = (k: string, fn: () => unknown) => {
    try { r[k] = fn(); } catch (err) { r[k] = { error: String(err) }; }
    console.log(e.name, k, JSON.stringify(r[k]));
  };
  t('features', () => features(e));
  t('torqueStability', () => torqueStability(e));
  t('collision', () => collision(e));
  t('determinism', () => determinism(e));
  for (const hz of [120, 240, 480]) t(`perf${hz}`, () => perf(e, hz));
  out[e.name] = r;
}

mkdirSync('bench/out', { recursive: true });
writeFileSync(`bench/out/engines-node${only ? '-' + only : ''}.json`, JSON.stringify(out, null, 2));
