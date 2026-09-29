import { expect, makeHousehold, test } from './fixtures.js';

/**
 * Not a test: the README's screenshots, taken of the built application drawing
 * the invented household in `makeHousehold`.
 *
 * Skipped unless asked for, so the gate never writes an image. After an interface
 * change worth showing:
 *
 *   npm run build && SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 *
 * and look at every file in `docs/screenshots` before committing it.
 */
const OUT = 'docs/screenshots';

test('the README screenshots', async ({ signedIn: page, api }) => {
  test.skip(process.env['SCREENSHOTS'] !== '1', 'Only when SCREENSHOTS=1.');
  test.setTimeout(180_000);
  await makeHousehold(api);

  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto('/overview?lines=all');
  await expect(page.getByText('Groceries').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/overview.png` });

  await page.goto('/transactions');
  await expect(page.getByText('KROGER #123 SPRINGFIELD').first()).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/transactions.png` });

  await page.goto('/recurring');
  await expect(page.getByText('OAK RIDGE APARTMENTS RENT').first()).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/recurring.png` });

  await page.evaluate(() => window.localStorage.setItem('budget.display.theme', 'dark'));
  await page.goto('/overview?lines=all');
  await expect(page.getByText('Groceries').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/overview-dark.png` });
  await page.evaluate(() => window.localStorage.setItem('budget.display.theme', 'light'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/overview?lines=all');
  await expect(page.getByText('Groceries').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/phone.png` });
});
