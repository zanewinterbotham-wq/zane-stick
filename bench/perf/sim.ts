// Headless physics cost per preset (Node): a 2-athlete tackle and a 17-athlete kickoff return, ms per simulated
// second with a breakdown, and a state hash so an optimization can be checked for bit-identical results.
//   npx tsx bench/perf/sim.ts [seconds] [preset ids…] [--phys={json}] [--scene=tackle|kickoff17]
//   (default 3 s, every preset, both scenes; --phys overrides the presets' physics settings, for experiments)
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
const seconds = +(pos[0] ?? 3), phys = JSON.parse(flag('phys') ?? '{}');
const names = (pos.slice(1).length ? pos.slice(1) : Object.keys(PRESETS)) as PresetName[];
const SCENES = [{ id: 'tackle', mode: 'tackle', opts: {} }, { id: 'kickoff17', mode: 'kickoffReturn', opts: { block: 7, cover: 9 } }].filter((s) => !flag('scene') || s.id === flag('scene'));

function config(p: PresetName): PlayConfig {
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
for (const name of names) {
  for (const sc of SCENES) {
    const def = modeById(sc.mode);
    const play = await Play.create(mujocoEngine, config(name), def, resolveOptions(def, sc.opts), null, 0);
    const w = play.world, n = Math.round(seconds / w.dt);
    // warm-up (JIT), then the measured run without wrappers, then a profiled run
    const t0 = performance.now();
    for (let i = 0; i < n; i++) play.step();
    const ms = performance.now() - t0;
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
    console.log(`${name.padEnd(8)} ${sc.id.padEnd(9)} ${Math.round(1 / w.dt)} Hz: ${(ms / seconds).toFixed(0).padStart(6)} ms/sim-s  hash ${hash}  instab ${w.scene.stats().instabilities}  contacts ${w.scene.stats().contacts}  [${parts}, rest ${(100 - Object.values(acc).reduce((a, b) => a + b, 0) / tot * 100).toFixed(0)}%]`);
    play.destroy();
  }
}
