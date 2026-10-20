// Shared e2e helpers: the error collector, the saved-settings seed, starting a mode from the Play menu, and a bot
// carrier that walks into the human.
import type { Page } from '@playwright/test';

const KEY = 'zane-stick-settings-v1';
// the physics engine's loader reports a slow wasm start as an error line under a busy machine: not a fault
const LOADER_NOISE = /still waiting on run dependencies|dependency: wasm|end of list/;

/** Collects console errors (but the loader noise), console warnings matching `warn`, and uncaught exceptions. */
export function watchErrors(page: Page, warn?: RegExp) {
  const errors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !LOADER_NOISE.test(t)) || (warn && m.type() === 'warning' && warn.test(t))) errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Saves settings before every load: the lowest preset with the physics on the page (no first-launch benchmark),
 *  plus `extra`. 'always' writes on every load, 'ifEmpty' only when nothing is stored, 'once' only on the first load. */
export function seed(page: Page, extra: Record<string, unknown> = {}, mode: 'always' | 'ifEmpty' | 'once' = 'always') {
  return page.addInitScript(([key, s, mode]) => {
    if (mode === 'ifEmpty' && localStorage.getItem(key)) return;
    if (mode === 'once') { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); }
    localStorage.setItem(key, s);
  }, [KEY, JSON.stringify({ preset: 'minimum', perf: { worker: false }, ...extra }), mode] as const);
}

/** From the title: Play, the mode card whose name matches, Start. */
export async function startMode(page: Page, mode: RegExp) {
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: mode }).click();
  await page.getByRole('button', { name: 'Start' }).click();
}

/** The AI carrier now dodges a straight run, so these UI tests have him walk into the human instead. */
export async function carrierComesToYou(page: Page) {
  await page.evaluate(() => {
    type V = [number, number, number];
    const d = (window as unknown as { __app: { drill: { carrier: number; human: number; brains: { think: unknown }[]; world: { athletes: { cmd: Record<string, unknown> }[] } } } }).__app.drill;
    d.brains[d.carrier] = { think: (p: { athletes: { com: V }[] }) => {
      const me = p.athletes[d.carrier].com, h = p.athletes[d.human].com, dx = h[0] - me[0], dz = h[2] - me[2], n = Math.hypot(dx, dz) || 1;
      return { ...d.world.athletes[d.carrier].cmd, move: { x: dx / n, z: dz / n }, face: null, gait: 'jog', carry: 2, dive: false, thrustHips: false };
    } };
  });
}
