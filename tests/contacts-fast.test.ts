// Contacts read straight off MuJoCo's arena (MujocoScene.contacts' fast path) are the binding's own reports, bit for bit,
// with either friction cone (the pyramid's normal force is decoded from its edges).
import { beforeAll, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { Play } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { mujocoEngine } from '../src/sim/physics/mujoco';

beforeAll(() => mujocoEngine.init());

it.each(['elliptic', 'pyramidal'] as const)('%s cone: the fast reads equal mj_contactForce and the contact structs', async (cone) => {
  const def = modeById('tackle'), { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
  const p = await Play.create(mujocoEngine, { ...base, physics: { hz: 240, iterations: 20, detail: 'minimum', cone }, bot: carrier, human: DEFAULT_ATHLETE }, def, resolveOptions(def, {}), null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc = p.world.scene as any;
  let compared = 0;
  for (let i = 0; i < 300; i++) {
    p.step();
    if (sc.d.ncon === 0) continue;
    const list = sc.d.contact, slow = sc.slowContacts(list, sc.d.ncon);
    list.delete();
    expect(sc.fastContacts(sc.d.arena.byteOffset, sc.d.ncon)).toEqual(slow);
    compared++;
  }
  expect(compared).toBeGreaterThan(200);
  p.destroy();
});
