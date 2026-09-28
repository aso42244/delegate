import { expect, test } from './fixtures.js';

/**
 * Signing out.
 *
 * Worth its own test because the failure mode is silent: the session is really
 * destroyed on the server, and the browser keeps rendering the budget from a
 * cache that was never emptied.
 */

test('sign out ends the session and returns to the login screen', async ({ signedIn: page }) => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await page
    .getByRole('dialog', { name: 'Sign out' })
    .getByRole('button', { name: 'Sign out' })
    .click();

  // Signing out is a full page load, so wait for the navigation to settle before
  // asserting on the document. Reaching for the field first races the teardown
  // of the page the click happened on, which fails perhaps one run in three.
  await page.waitForURL('**/login');
  await expect(page.getByLabel('Username')).toBeVisible();

  // And the budget is genuinely out of reach, not merely off-screen.
  await page.goto('/budget');
  await expect(page.getByLabel('Username')).toBeVisible();
});

/**
 * It asks first, and a cancel really is one.
 *
 * The button sits 8px under Sync SimpleFIN, which is pressed several times a
 * day, and signing out is a full page load: a misclick costs the whole session
 * and everything typed into it, with no undo and no state to come back to. Every
 * other control in that zone asks, and this one did not.
 */
test('signing out asks first, and cancelling stays put', async ({ signedIn: page }) => {
  await page.goto('/budget');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Sign out' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Still signed in, still on the page it was opened from.
  await expect(page).toHaveURL(/\/budget$/);
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
});
