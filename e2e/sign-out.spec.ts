import { expect, test } from './fixtures.js';

/**
 * Signing out.
 *
 * Worth its own test because the failure mode is silent: the session is really
 * destroyed on the server, and the browser keeps rendering the budget from a
 * cache that was never emptied.
 */

test('sign out ends the session and returns to the login screen', async ({ signedIn: page }) => {
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByLabel('Username')).toBeVisible();
  expect(page.url()).toContain('/login');

  // And the budget is genuinely out of reach, not merely off-screen.
  await page.goto('/');
  await expect(page.getByLabel('Username')).toBeVisible();
});
