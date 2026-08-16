import { expect, makeSyncWarning, test } from './fixtures.js';

/**
 * The banner for a sync that succeeded while the feed complained.
 *
 * SimpleFIN reports an expired bank login per-institution without failing the
 * run, because the other institutions synced fine. That was recorded on the run
 * from the beginning but legible only on the Settings page, so an account could
 * quietly stop updating while everything else looked healthy.
 */

const WARNING = 'Connection to Frontier Bank may need attention. Auth required';

test('a feed complaint reaches every page, and names the bank', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await signedIn.reload();

  // Scoped to the banner: Settings lists the same text under Recent syncs, which
  // is exactly the place this exists so he does not have to go looking.
  const banner = signedIn.getByRole('status').filter({ hasText: WARNING });
  await expect(banner).toBeVisible();

  // Above whatever page he is on, not only the one it came from.
  for (const path of ['/transactions', '/utilities', '/insights', '/settings']) {
    await signedIn.goto(path);
    await expect(signedIn.getByRole('status').filter({ hasText: WARNING })).toBeVisible();
  }
});

test('dismissing puts it away, and it stays away across a reload', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await signedIn.reload();

  await signedIn.getByRole('button', { name: `Dismiss: ${WARNING}` }).click();
  await expect(signedIn.getByRole('status').filter({ hasText: WARNING })).toBeHidden();

  // The snooze has to survive a reload, or the X is a button that does nothing.
  await signedIn.reload();
  await expect(signedIn.getByRole('status').filter({ hasText: WARNING })).toBeHidden();

  // And it does not take the next problem with it: a different message is news
  // again, which is what keeps a snooze from becoming a permanent mute.
  await makeSyncWarning('Connection to Plains Commerce may need attention');
  await signedIn.reload();
  await expect(
    signedIn.getByText('Connection to Plains Commerce may need attention'),
  ).toBeVisible();
});
