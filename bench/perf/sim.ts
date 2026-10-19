// Headless physics cost per preset (Node): a 2-athlete tackle and a 17-athlete kickoff return, ms per simulated
// second with a breakdown, and a state hash so an optimization can be checked for bit-identical results.
//   npx tsx bench/perf/sim.ts [seconds] [preset ids…] [--phys={json} | --vary=[{json}, …]] [--scene=tackle|kickoff17] [--reps=3]
//   (default 3 s, every preset, both scenes; --phys overrides the presets' physics settings, --vary runs each override)
import { createHash } from 'node:crypto';
import { DEFAULT_ATHLETE } from '../../src/sim/anatomy/body';
import { carrierSkill } from '../../src/sim/brains/carrier';
import { tacklerSkill } from '../../src/sim/brains/tackler';
import { Play } from '../../src/sim/modes/play';
import { modeById, resolveOptions } from '../../src/sim/modes/registry';
import type { PlayConfig } from '../../src/sim/modes/types';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import { PRESETS, type PresetName } from '../../src/game/presets';
import { GAME_SUPPORT, PLAYER_BASE } from '../../src/game/settings';

const args = process.argv.slice(2), flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const pos = args.filter((a) => !a.startsWith('--'));
const reps = +(flag('reps') ?? 3), seconds = +(pos[0] ?? 3), vary: object[] = JSON.parse(flag('vary') ?? `[${flag('phys') ?? '{}'}]`);
const names = (pos.slice(1).length ? pos.slice(1) : Object.keys(PRESETS)) as PresetName[];
const SCENES = [{ id: 'tackle', mode: 'tackle', opts: {} }, { id: 'kickoff17', mode: 'kickoffReturn', opts: { block: 7, cover: 9 } }].filter((s) => !flag('scene') || s.id === flag('scene'));

function config(p: PresetName, phys: object): PlayConfig {
  const pr = PRESETS[p];
  return { physics: { ...pr.physics, ...phys }, assist: 0.2, seed: 1, difficulty: carrierSkill(0.5), defense: tacklerSkill(0.5), toughness: 1, hitPower: 1.5, boneStrength: 1, aiBoneStrength: 1,
    carrierGait: 'jog', activeBots: pr.activeBots, human: { ...DEFAULT_ATHLETE, strength: PLAYER_BASE.strength, speed: PLAYER_BASE.speed }, bot: { height: 1.8, mass: 98, strength: 1, speed: 1 },
    traction: 1.2, gains: {}, support: { ...GAME_SUPPORT } };
}

/** Wrap obj[k] to add its wall time to acc[label]. */
function timeIt(acc: Record<string, number>, label: string, obj: any, k: string) {
  const f = obj[k].bind(obj);
  obj[k] = (...a: unknown[]) => { const t = performance.now(); const r = f(...a); acc[label] = (acc[label] ?? 0) + performance.now() - t; return r; };
}

await mujocoEngine.init();
// every configuration once per round, `reps` rounds (interleaved, so a slow spell of the machine hits them all), the
// fastest round of each is its cost (other load only adds); then a profiled second on a fresh run
const runs = vary.flatMap((phys) => names.flatMap((name) => SCENES.map((sc) => ({ phys, name, sc, ms: Infinity }))));
const make = (r: (typeof runs)[number]) => { const def = modeById(r.sc.mode); return Play.create(mujocoEngine, config(r.name, r.phys), def, resolveOptions(def, r.sc.opts), null, 0); };
for (let k = 0; k < reps; k++) for (const r of runs) {
  const play = await make(r);
  const t0 = process.cpuUsage(); // CPU time, not wall time: less of the other load on the machine
  for (let i = 0, n = Math.round(seconds / play.world.dt); i < n; i++) play.step();
  const u = process.cpuUsage(t0); r.ms = Math.min(r.ms, (u.user + u.system) / 1000);
  play.destroy();
}
for (const { phys, name, sc, ms } of runs) {
  const play = await make({ phys, name, sc, ms }), w = play.world;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) play.step();
  const st = w.scene.athletes.flatMap((a) => [...a.state.segPos, ...a.state.qd]);
  const hash = createHash('sha1').update(new Float64Array(st)).digest('hex').slice(0, 10);
  const acc: Record<string, number> = {};
  timeIt(acc, 'mj_step+read', w.scene, 'step');
  timeIt(acc, 'contacts', w.scene, 'contacts');
  for (const a of w.athletes) { timeIt(acc, 'controller', a.controller, 'compute'); timeIt(acc, 'muscles', a.muscles, 'compute'); timeIt(acc, 'brain', a.brain, 'think'); }
  const n2 = Math.round(1 / w.dt), t1 = performance.now();
  for (let i = 0; i < n2; i++) play.step();
  const tot = performance.now() - t1;
  const parts = Object.entries(acc).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(0)}%`).join(', ');
  console.log(`${vary.length > 1 ? JSON.stringify(phys) + ' ' : ''}${name.padEnd(8)} ${sc.id.padEnd(9)} ${Math.round(1 / w.dt)} Hz: ${(ms / seconds).toFixed(0).padStart(6)} ms/sim-s  hash ${hash}  instab ${w.scene.stats().instabilities}  contacts ${w.scene.stats().contacts}  [${parts}, rest ${(100 - Object.values(acc).reduce((a, b) => a + b, 0) / tot * 100).toFixed(0)}%]`);
  play.destroy();
}
