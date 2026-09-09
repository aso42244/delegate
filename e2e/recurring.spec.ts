import { expect, makeDelegation, test } from './fixtures.js';

/**
 * Recurring.
 *
 * Bills and Utilities were two sidebar entries over the same merchants — one
 * watching whether a charge arrived, one judging whether the line is funded at
 * what it costs — and Electricity sat on both, described two different ways.
 *
 * What is guarded here is that the merge kept both answers and both addresses:
 * neither view is a filter of the other, and the two old links still land on the
 * half they named.
 */

test('is one entry in the sidebar, with both views behind it', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await expect(signedIn.getByRole('link', { name: 'Recurring', exact: true })).toBeVisible();
  await expect(signedIn.getByRole('link', { name: 'Bills', exact: true })).toHaveCount(0);
  await expect(signedIn.getByRole('link', { name: 'Utilities', exact: true })).toHaveCount(0);

  await signedIn.getByRole('link', { name: 'Recurring', exact: true }).click();
  await expect(signedIn.getByRole('heading', { name: 'Recurring' })).toBeVisible();

  // Due first: what did not arrive is the question the page exists for.
  await expect(signedIn.getByRole('radio', { name: 'Due' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(signedIn.getByText('No bill has arrived three times yet.')).toBeVisible();
});

test('the view is in the URL, so it survives leaving the page', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/recurring');
  await signedIn.getByRole('radio', { name: 'Cost' }).click();
  await expect(signedIn.getByRole('heading', { name: 'Water' })).toBeVisible();
  await expect(signedIn).toHaveURL(/view=cost/);

  /*
   * A view kept in component state resets every time somebody follows a link out
   * and comes back — which is how Insights lost its window on every navigation,
   * including on a press of one of its own tiles.
   */
  await signedIn.goto('/transactions');
  await signedIn.goBack();
  await expect(signedIn.getByRole('heading', { name: 'Water' })).toBeVisible();
});

test('the two old addresses land on the half they named', async ({ signedIn }) => {
  // A bookmark is a promise, and the page it pointed at still exists as a view.
  await signedIn.goto('/bills');
  await expect(signedIn).toHaveURL(/\/recurring$/);
  await expect(signedIn.getByRole('radio', { name: 'Due' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await signedIn.goto('/utilities');
  await expect(signedIn).toHaveURL(/view=cost/);
  await expect(signedIn.getByRole('radio', { name: 'Cost' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
