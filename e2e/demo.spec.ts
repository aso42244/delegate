import { expect, test } from './fixtures.js';

/**
 * The demo.
 *
 * A route, not a deployment: `/demo/overview` is the same page as `/overview` —
 * the same components, the same queries, the same session — drawing invented
 * numbers. It is behind the household's sign-in because it *is* the application,
 * and the only thing that differs is where the figures come from.
 */

test('shows a household without touching the real one', async ({ signedIn }) => {
  await signedIn.goto('/demo/overview');

  // Invented, and plausible: eighteen months of history behind it.
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(signedIn.getByText('Groceries').first()).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Cashflow', level: 2 })).toBeVisible();

  /*
   * And the real page is untouched by it. This is the assertion that matters:
   * the demo answers inside one `fetch`, and a mistake there would be invented
   * numbers on the household's own page.
   */
  await signedIn.goto('/overview');
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(signedIn.getByText('Groceries')).toHaveCount(0);
});

test('offers nothing that would change anything', async ({ signedIn }) => {
  await signedIn.goto('/demo/overview');

  /*
   * Every control that writes is absent. There is no server behind the demo to
   * refuse them — the figures are computed in the browser — so a control that
   * appeared here would fail in a way nobody could explain.
   */
  await expect(signedIn.getByRole('button', { name: 'New …' })).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Arrange' })).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: /Sync SimpleFIN/ })).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: /Select Delegations/ })).toHaveCount(0);

  // Settings is where the bank-feed credential lives. Not on the demo.
  await expect(signedIn.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

test('keeps you in the demo once you are in it', async ({ signedIn }) => {
  await signedIn.goto('/demo/overview');

  /*
   * The first press of "Budget" must not land somebody in their own money
   * halfway through showing somebody else's.
   */
  await signedIn.getByRole('link', { name: 'Budget' }).click();
  await expect(signedIn).toHaveURL(/\/demo\/budget$/);
  await expect(signedIn.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();
});
