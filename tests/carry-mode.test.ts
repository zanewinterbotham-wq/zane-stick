// Carry mode: the human starts with the ball and runs for the far end zone; the bot tackles.
import { beforeAll, expect, it } from 'vitest';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { ScriptBrain } from '../src/sim/brains/script';
import { TacklerBrain } from '../src/sim/brains/tackler';

beforeAll(() => mujocoEngine.init());
const PH = { hz: 240, iterations: 30, detail: 'standard' as const };

it('the human holds the ball, attacks +Z, and the bot tackler brings him down or he scores', async () => {
  const ends: string[] = [];
  for (let rep = 0; rep < 3; rep++) {
    const human = new ScriptBrain((_t, _p, c) => { c.gait = 'jog'; c.move = { x: 0, z: 1 }; });
    const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: PH, mode: 'carry' }, human, rep);
    expect(d.world.ballCarrier).toBe(d.human);
    expect(d.world.perception(d.human).field.dirZ).toBe(1);
    expect(d.brains[d.carrier]).toBeInstanceOf(TacklerBrain);
    let contact = false;
    while (!d.ended && d.repTime < 20) { d.step(); contact ||= d.world.athletes[d.human].playerContact; }
    ends.push(`${d.ended}${contact ? '' : ' (no contact)'}`);
    expect(d.world.scene.stats().instabilities).toBe(0);
    d.destroy();
  }
  console.log('carry mode ends:', ends.join(', '));
  expect(ends.some((e) => e === 'down')).toBe(true); // the bot gets to him
  expect(ends.every((e) => e === 'down' || e === 'touchdown')).toBe(true);
}, 120_000);
