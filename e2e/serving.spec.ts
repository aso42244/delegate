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
  await page.goto('/budget');
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

/**
 * The icon, which is three files and a `<link>` each.
 *
 * Worth a test for the same reason the hashed asset above is: a favicon that
 * 404s is invisible. The browser falls back to a blank page mark, which is
 * exactly what it showed before there was an icon at all, so nothing about the
 * failure looks like a failure.
 *
 * Content type as well as status, because `public/` is copied by Vite rather
 * than hashed by it — a file that never reached `dist` would fall through to the
 * SPA handler, and only the type says whether what came back was the icon.
 */
test('every icon the page links to is served as an image', async ({ request, page }) => {
  await page.goto('/overview');

  const links = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"]').all();
  // Three: the SVG, the PNG a browser without SVG support takes, and the one
  // iOS uses on a home screen.
  expect(links).toHaveLength(3);

  for (const link of links) {
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();

    const response = await request.get(href!);
    expect(response.status(), `${href} is missing`).toBe(200);
    expect(response.headers()['content-type'], `${href} is not an image`).toContain('image/');
  }
});

test('an unknown API route returns JSON, not HTML', async ({ request }) => {
  const response = await request.get('/api/definitely-not-a-route');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('json');
});
