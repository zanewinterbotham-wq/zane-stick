// The hip thrust in the real renderer (owner request 2026-10-18): side views of a thrust into a standing opponent from
// pads fully down, half down and upright, before, at and after contact. Screenshots in test-results/thrust-*.png.
import { expect, test } from '@playwright/test';

type Zs = { __zs: {
  advance(s: number): number;
  world: { time: number; dt: number; athletes: { playerContact: boolean }[]; scene: { athletes: { state: { com: Float64Array } }[] } };
  renderer: { render(w: unknown): void; camera: { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void } };
} };

for (const torso of [1, 0.6, 0]) {
  test(`thrust from pads ${torso}: side views through the hit`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/still waiting on run dependencies|dependency: wasm|end of list/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?scenario=thrust&torso=${torso}&gfx=high`);
    await page.waitForFunction(() => (window as unknown as Zs).__zs);
    // set (before the press), the drive, first contact, through it and after
    const shots: [string, number][] = [['set', 1.15], ['drive', 1.35], ['contact', 0], ['through', 0.12], ['after', 0.35]];
    for (const [k, [name, t]] of shots.entries()) {
      const touched = await page.evaluate(([name, t]) => {
        const zs = (window as unknown as Zs).__zs, w = zs.world;
        if (name === 'contact') while (!w.athletes[0].playerContact && w.time < 3) zs.advance(w.dt);
        else if (name === 'set' || name === 'drive') while (w.time < t) zs.advance(w.dt);
        else zs.advance(t);
        // a fixed side view from the hitter's right, centred between the two
        const a = w.scene.athletes[0].state.com, b = w.scene.athletes[1].state.com, z = (a[2] + b[2]) / 2;
        zs.renderer.camera.position.set(-3.2, 1.1, z);
        zs.renderer.camera.lookAt(0, 0.9, z);
        zs.renderer.render(w);
        return w.athletes[0].playerContact;
      }, [name, t] as [string, number]);
      await page.screenshot({ path: `test-results/thrust-${torso}-${k}-${name}.png` });
      if (name === 'contact') expect(touched).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}
