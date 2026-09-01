import { expect, makeSyncFailure, makeSyncWarning, test } from './fixtures.js';

/**
 * What the application says about a sync, and how loudly.
 *
 * SimpleFIN reports an expired bank login per-institution without failing the
 * run, because the other institutions synced fine. That was recorded on the run
 * from the beginning but legible only on the Settings page, so an account could
 * quietly stop updating while everything else looked healthy.
 *
 * Every notification is a pill in the page header. They were full-width bars,
 * and two of them stacked above the page — a yellow one and a blue one — pushed
 * the budget a third of the way down the screen to say six words. A run that
 * *fails* is a red pill rather than a red bar: louder in colour and in wording,
 * not in floor space.
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
 * A failing run is the loudest thing this application says, and it says it in a
 * pill like everything else.
 *
 * It was a bar until now, on the argument that a sync failing silently is worse
 * than a bank wanting a fresh login — which is true, and is why it is red and
 * why it says so in words. None of that needed a row of the Budget page.
 */
test('a failing sync is a red pill, and nothing sits above the page', async ({ signedIn }) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const pill = signedIn.getByRole('link', { name: 'Sync failing' });
  await expect(pill).toBeVisible();
  await pill.hover();
  await expect(signedIn.getByRole('tooltip')).toContainText(
    'Balances and transactions are not up to date',
  );

  // The header, not a band above it: the pill sits on the same line as the title.
  const heading = await signedIn.getByRole('heading', { name: 'Budget' }).boundingBox();
  const box = await pill.boundingBox();
  expect(box!.y).toBeGreaterThan(heading!.y - heading!.height);
  expect(box!.y).toBeLessThan(heading!.y + heading!.height);

  await pill.click();
  await expect(signedIn).toHaveURL(/\/settings\/sync$/);
});

/**
 * Nothing can be put away any more, at any severity.
 *
 * Snoozing existed because a bar was in the way — it was a snooze rather than a
 * clear, so the interface never told a lie on the owner's behalf about a
 * condition that still held. A pill is not in the way, so there is nothing to
 * put away and what makes one go away is fixing the thing.
 */
test('no notification offers a dismissal', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  await expect(signedIn.getByRole('link', { name: 'Sync failing' })).toBeVisible();
  await expect(signedIn.getByRole('button', { name: /^Dismiss:/ })).toHaveCount(0);
});
