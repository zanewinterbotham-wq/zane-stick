import { rapierEngine } from '../rapier';
import { joltEngine } from '../jolt';
import { mujocoEngine } from '../mujoco';
import { perf } from '../scenarios';

const engines = [rapierEngine('det', 'impulse'), joltEngine, mujocoEngine('damped')];
const out: Record<string, unknown> = {};
for (const e of engines) {
  await e.init();
  out[e.name] = [120, 240, 480].map((hz) => perf(e, hz, 2));
  document.getElementById('o')!.textContent = JSON.stringify(out, null, 1);
}
(window as unknown as { __done: unknown }).__done = out;
