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

  // Signing out is a full page load, so wait for the navigation to settle before
  // asserting on the document. Reaching for the field first races the teardown
  // of the page the click happened on, which fails perhaps one run in three.
  await page.waitForURL('**/login');
  await expect(page.getByLabel('Username')).toBeVisible();

  // And the budget is genuinely out of reach, not merely off-screen.
  await page.goto('/');
  await expect(page.getByLabel('Username')).toBeVisible();
});
