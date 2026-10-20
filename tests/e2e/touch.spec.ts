// Touch controls on a phone-size touch screen: the buttons press the bound keys, the stick moves, and a dragged button
// keeps its new place after a reload.
import { expect, test, type Page } from '@playwright/test';
import { seed, startMode, watchErrors } from './helpers';

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

const keys = (page: Page) => page.evaluate(() => [...window.__app.input.keys]);
const ptr = (page: Page, sel: string, type: string, x = 0, y = 0) => page.locator(sel).evaluate((e, [type, x, y]) => {
  const r = e.getBoundingClientRect();
  e.dispatchEvent(new PointerEvent(type as string, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, buttons: 1,
    clientX: r.left + r.width / 2 + (x as number), clientY: r.top + r.height / 2 + (y as number) }));
}, [type, x, y] as const);

test('touch buttons press keys, the stick moves, a moved button stays moved', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, { mute: true }, 'once');
  await page.goto('/');
  await startMode(page, /^Ball Carrier/);
  await expect(page.locator('.tbtn[data-id="jump"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/touch-controls.png' });

  await ptr(page, '.tbtn[data-id="jump"]', 'pointerdown');
  expect(await keys(page)).toContain('Space');
  await ptr(page, '.tbtn[data-id="jump"]', 'pointerup');
  expect(await keys(page)).not.toContain('Space');

  await ptr(page, '.tstick', 'pointerdown', 0, -60); // stick pushed up: forward
  expect(await keys(page)).toContain('KeyW');
  await ptr(page, '.tstick', 'pointerup');
  expect(await keys(page)).not.toContain('KeyW');

  // the pause button opens the pause menu, and the controls hide under it; Resume brings them back
  await ptr(page, '.tbtn[data-id="pause"]', 'pointerdown'); await ptr(page, '.tbtn[data-id="pause"]', 'pointerup');
  await expect(page.locator('.touch')).toBeHidden();
  await page.getByRole('button', { name: /^Resume/ }).click();
  await expect(page.locator('.touch')).toBeVisible();

  // edit the layout: drag Jump to the middle, then it is there after a reload
  await page.locator('.tbtn.small', { hasText: '✎' }).dispatchEvent('pointerdown');
  await ptr(page, '.tbtn[data-id="jump"]', 'pointerdown');
  await page.locator('.tbtn[data-id="jump"]').evaluate((e) => {
    const o = { bubbles: true, pointerId: 7, pointerType: 'touch', buttons: 1, clientX: innerWidth / 2, clientY: innerHeight / 2 };
    e.dispatchEvent(new PointerEvent('pointermove', o)); e.dispatchEvent(new PointerEvent('pointerup', o));
  });
  expect(await keys(page)).not.toContain('Space'); // editing never presses
  await page.reload();
  await startMode(page, /^Ball Carrier/);
  await expect(page.locator('.tbtn[data-id="jump"]')).toHaveCSS('left', '422px');
  expect(errors).toEqual([]);
});
