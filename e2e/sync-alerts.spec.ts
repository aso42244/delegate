import { expect, makeSyncFailure, makeSyncWarning, test } from './fixtures.js';

/**
 * What the application says about a sync, and how loudly.
 *
 * SimpleFIN reports an expired bank login per-institution without failing the
 * run, because the other institutions synced fine. That was recorded on the run
 * from the beginning but legible only on the Settings page, so an account could
 * quietly stop updating while everything else looked healthy.
 *
 * It is a pill in the page header rather than a bar across it. A bank wanting a
 * fresh login is real and is not an emergency, and two of these stacked above
 * the page — a yellow one and a blue one — pushed the budget a third of the way
 * down the screen to say six words. A run that *fails* still gets the bar.
 */

const WARNING = 'Connection to Frontier Bank may need attention. Auth required';

test('a feed complaint reaches every page, and names the bank', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await signedIn.reload();

  const pill = signedIn.getByRole('link', { name: 'Sync issue' });
  await expect(pill).toBeVisible();

  // Two or three words on its face and the whole of it on hover. The bank's name
  // is the part that matters and the part a pill cannot carry. A hidden tooltip
  // is out of the accessibility tree entirely, so nothing can ask about it by
  // role until it is revealed — which is also the behaviour worth testing.
  await expect(signedIn.getByRole('tooltip')).toHaveCount(0);
  await pill.hover();
  await expect(signedIn.getByRole('tooltip')).toContainText(WARNING);

  // It goes where the connection is dealt with.
  await pill.click();
  await expect(signedIn).toHaveURL(/\/settings\/sync$/);

  // On every page, not only the one it came from.
  for (const path of ['/transactions', '/utilities', '/insights', '/settings']) {
    await signedIn.goto(path);
    await expect(signedIn.getByRole('link', { name: 'Sync issue' })).toBeVisible();
  }
});

/**
 * The bar is what can be dismissed, and it is dismissed for a day rather than
 * cleared: a bar put away for a condition that is still true would be a lie the
 * interface tells on the owner's behalf.
 *
 * The pills carry no dismiss at all. Snoozing exists because a bar is in the
 * way, and a pill is not in the way.
 */
test('a failing sync gets a bar, and the bar can be put away for a day', async ({ signedIn }) => {
  const FAILURE = 'The last sync failed';
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const bar = signedIn.getByRole('status').filter({ hasText: FAILURE });
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: /^Dismiss:/ }).click();
  await expect(signedIn.getByRole('status').filter({ hasText: FAILURE })).toBeHidden();

  // The snooze has to survive a reload, or the X is a button that does nothing.
  await signedIn.reload();
  await expect(signedIn.getByRole('status').filter({ hasText: FAILURE })).toBeHidden();
});

/** A pill has no X: there is nothing about it to put away. */
test('a pill offers no dismissal', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await signedIn.reload();

  await expect(signedIn.getByRole('link', { name: 'Sync issue' })).toBeVisible();
  await expect(signedIn.getByRole('button', { name: `Dismiss: ${WARNING}` })).toHaveCount(0);
});
