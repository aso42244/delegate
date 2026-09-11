import { expect, makeDelegation, test } from './fixtures.js';

/**
 * Recurring.
 *
 * Bills and Utilities were two sidebar entries over the same merchants — one
 * watching whether a charge arrived, one judging whether the line is funded at
 * what it costs — and Electricity sat on both, described two different ways.
 *
 * What is guarded here is that the merge kept both answers and both addresses.
 * Since ADR 061 it also guards that both are on the screen **at once**: they
 * were two views behind a segmented control, and a switch between two answers
 * that are never in each other is a switch somebody has to press to find out
 * which one they wanted.
 */

test('is one entry in the sidebar, with both halves behind it', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await expect(signedIn.getByRole('link', { name: 'Recurring', exact: true })).toBeVisible();
  await expect(signedIn.getByRole('link', { name: 'Bills', exact: true })).toHaveCount(0);
  await expect(signedIn.getByRole('link', { name: 'Utilities', exact: true })).toHaveCount(0);

  await signedIn.getByRole('link', { name: 'Recurring', exact: true }).click();
  await expect(signedIn.getByRole('heading', { name: 'Recurring' })).toBeVisible();

  // Both, without pressing anything. Neither answer is in the other, so neither
  // is a filter of the other and neither waits behind a switch.
  await expect(signedIn.getByRole('heading', { name: 'Due' })).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Per cycle' })).toBeVisible();

  await expect(signedIn.getByText('No bill has arrived three times yet.')).toBeVisible();
  await expect(signedIn.getByText('No delegations are marked as a utility.')).toBeVisible();

  // The switch is gone with the views it selected.
  await expect(signedIn.getByRole('radio', { name: 'Due' })).toHaveCount(0);
  await expect(signedIn.getByRole('radio', { name: 'Cost' })).toHaveCount(0);
});

test('both halves are on the screen together', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/recurring');

  // The Due tile's own control, and a Cost row, without a navigation between
  // them: this is the whole of what putting them side by side bought.
  await expect(signedIn.getByLabel('Search bills')).toBeVisible();
  // Twice, once in each Cost tile — which is itself the assertion: the
  // per-cycle comparison and the twelve months are both on screen.
  await expect(signedIn.getByText('Water')).toHaveCount(2);
});

test('the two old addresses land on the page carrying both halves', async ({ signedIn }) => {
  // A bookmark is a promise, and the page each pointed at is on this screen.
  await signedIn.goto('/bills');
  await expect(signedIn).toHaveURL(/\/recurring$/);
  await expect(signedIn.getByRole('heading', { name: 'Due' })).toBeVisible();

  await signedIn.goto('/utilities');
  await expect(signedIn).toHaveURL(/\/recurring$/);
  await expect(signedIn.getByRole('heading', { name: 'Per cycle' })).toBeVisible();
});
