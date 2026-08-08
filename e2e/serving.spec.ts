import { expect, test } from '@playwright/test';

/**
 * How the server serves the built UI.
 *
 * A regression guard: the application once returned `index.html` with a 200 for
 * a missing hashed asset, so the browser rendered a blank page and reported only
 * "Expected a JavaScript module but got text/html" — a message that points
 * nowhere near the cause. Every check here failed silently at the time.
 */

test('a hashed asset is served as JavaScript, not as the fallback page', async ({
  request,
  page,
}) => {
  await page.goto('/');
  const asset = await page.locator('script[type=module]').getAttribute('src');
  expect(asset).toBeTruthy();

  const response = await request.get(asset!);
  expect(response.status()).toBe(200);
  // The status alone was 200 while the body was HTML, which is what made the
  // original failure so hard to see.
  expect(response.headers()['content-type']).toContain('javascript');
});

test('a missing file returns 404 rather than the fallback page', async ({ request }) => {
  const response = await request.get('/assets/does-not-exist.js');

  // A path with an extension is asking for a file. Answering with index.html
  // turns a missing asset into a MIME type error somewhere else entirely.
  expect(response.status()).toBe(404);
});

test('a deep link still renders the application', async ({ page }) => {
  await page.goto('/transactions');
  await expect(page.getByRole('heading', { name: 'Delegate' })).toBeVisible();
});

test('an unknown API route returns JSON, not HTML', async ({ request }) => {
  const response = await request.get('/api/definitely-not-a-route');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('json');
});
