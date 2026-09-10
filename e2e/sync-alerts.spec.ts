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
  for (const path of ['/transactions', '/recurring', '/overview', '/settings']) {
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
test('a failing sync is a red tag in the sidebar, not a band above the page', async ({
  signedIn,
}) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const pill = signedIn.getByRole('link', { name: 'Sync failing' });
  await expect(pill).toBeVisible();
  await pill.hover();
  await expect(signedIn.getByRole('tooltip')).toContainText(
    'Balances and transactions are not up to date',
  );

  /*
   * In the sidebar, and nothing above the page.
   *
   * The original assertion was that the pill sat on the title's line, which was
   * the point when the alternative was a full-width band pushing the budget down
   * the screen. The band is still the thing being ruled out; the pill has simply
   * moved to the foot of the navigation, so the assertion is that it is inside
   * the sidebar and that the heading is still at the top of the page.
   */
  const nav = await signedIn.getByRole('navigation', { name: 'Main' }).boundingBox();
  const heading = await signedIn.getByRole('heading', { name: 'Budget' }).boundingBox();
  const box = await pill.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(nav!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(nav!.x + nav!.width);
  // Nothing has been inserted above the title.
  expect(heading!.y).toBeLessThan(120);

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

/**
 * The reading is the last row, and nothing widens the sidebar.
 *
 * The budget's own reading is always the bottom of the stack, so it is in the
 * same place whatever else the application has to say today, and a long alert
 * gives way rather than pushing the navigation wider.
 *
 * The *ordering* between severities is proved in `Alerts.test.ts` instead. It
 * cannot be staged here: the API reports the worst sync condition rather than
 * all of them, and it suppresses "not reporting" while a sync is failing
 * outright — both right, and between them there is no way to have two severities
 * on screen at once.
 */
test('the budget reading is the last alert, and none of them widen the sidebar', async ({
  signedIn,
}) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const nav = signedIn.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Sync failing' })).toBeVisible();

  const stack = await nav.evaluate((node) =>
    Array.from(node.querySelectorAll('[aria-describedby]')).map((el) => {
      const box = el.getBoundingClientRect();
      return { text: (el.textContent ?? '').trim(), top: Math.round(box.top), right: box.right };
    }),
  );

  // Rendered order is top to bottom, so the array order is the reading order.
  const tops = stack.map((entry) => entry.top);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  expect(stack.length).toBeGreaterThan(1);
  expect(stack[stack.length - 1]!.text).toMatch(/Balanced|To delegate|Over-delegated/);

  const box = (await nav.boundingBox())!;
  for (const entry of stack) {
    expect(entry.right).toBeLessThanOrEqual(box.x + box.width);
  }
});
