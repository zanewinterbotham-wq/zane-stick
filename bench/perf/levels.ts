// Gameplay metrics per quality level (the realism suite's level equivalence, printed), for tuning a level.
//   npx tsx bench/perf/levels.ts [preset ids…] [--vary=[{json}, …]] [--seeds=8]
import { PRESETS, type PresetName } from '../../src/game/presets';
import { hitHash, levelMetrics } from '../../tests/helpers/levels';

const args = process.argv.slice(2), flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const names = (args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : Object.keys(PRESETS)) as PresetName[];
const vary: object[] = JSON.parse(flag('vary') ?? '[{}]'), seeds = +(flag('seeds') ?? 8);
for (const v of vary) for (const n of names) {
  const physics = { ...PRESETS[n].physics, ...v }, t0 = performance.now();
  const m = await levelMetrics(physics, seeds), f = (x: number) => x.toFixed(2);
  console.log(`${n}${vary.length > 1 ? ' ' + JSON.stringify(v) : ''}: balance ${m.balance} sprint ${f(m.sprintTop)} up ${m.sprintUp} cut ${m.cutUp} ${m.cutDeg.toFixed(0)}° hit down ${f(m.hitDown)} back ${f(m.hitBack)} hitter down ${f(m.hitterDown)} kick land ${f(m.kickLand)} rest ${m.kickRest.toFixed(3)} instab ${m.instabilities} hash ${(await hitHash(physics)).slice(0, 10)} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
