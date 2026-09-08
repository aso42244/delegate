import { expect, test } from './fixtures.js';

/**
 * Overview — the spine.
 *
 * Not in the sidebar: it is reachable at `/overview` while the tiles are ported
 * in batches, so the tests navigate there by URL deliberately rather than by
 * pressing a link that does not exist yet.
 *
 * Three properties are worth protecting here, and each of them is a defect this
 * page was built to avoid rather than a feature it happens to have.
 *
 * **The period survives leaving the page.** Insights kept its window in
 * component state and reset to thirty days every time somebody navigated away —
 * including when they left by pressing one of its own tiles.
 *
 * **An arrangement survives a reload.** The risk an optimistic update
 * introduces is one that never reaches the server: perfect on screen until the
 * page is loaded again. So these reload.
 *
 * **A width is a width, not a guess.** The span is asserted as a class on the
 * tile rather than by reading text, for the reason the settings-card overflow
 * needed in v0.49.0: an assertion that only looks for words passes just as
 * happily while the layout is wrong.
 */

/** Both proof tiles, so the grid has something in it to arrange. */
async function addBothTiles(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.getByRole('button', { name: 'Spending by grouping' }).click();
  await expect(page.getByRole('heading', { name: 'Spending by grouping' })).toBeVisible();
  await page.getByRole('button', { name: 'Waiting to be categorized' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to be categorized' })).toBeVisible();
}

test('starts empty and says so in one sentence', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // The text budget: one short sentence, no instructions. Where to go next is on
  // the control that goes there.
  await expect(signedIn.getByText('No tiles yet.').first()).toBeVisible();
});

test('a tile added stays across a reload', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  await signedIn.reload();

  // The whole risk of an optimistic write is that it never lands. This is the
  // assertion that would catch it.
  await expect(signedIn.getByRole('heading', { name: 'Spending by grouping' })).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Waiting to be categorized' })).toBeVisible();
});

test('the order a person chooses survives a reload', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  const headings = signedIn.getByRole('heading', { level: 2 });
  await expect(headings).toHaveText(['Spending by grouping', 'Waiting to be categorized']);

  // Addressed by name rather than by index: every tile's controls name the tile
  // they act on, which is what makes them distinguishable to a screen reader.
  await signedIn.getByRole('button', { name: 'Move Waiting to be categorized earlier' }).click();
  await expect(headings).toHaveText(['Waiting to be categorized', 'Spending by grouping']);

  await signedIn.reload();
  await expect(headings).toHaveText(['Waiting to be categorized', 'Spending by grouping']);
});

test('a width is stored, and it is the grid that changes', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  const tile = signedIn.getByRole('heading', { name: 'Spending by grouping' }).locator('../..');
  // A tile that has not been sized is full width — the width every card here has
  // always had.
  await expect(tile).toHaveClass(/lg:col-span-6/);

  // Cycling from full wraps to the first width rather than stopping.
  await signedIn.getByRole('button', { name: 'Width of Spending by grouping: Full' }).click();
  await expect(tile).toHaveClass(/lg:col-span-2/);

  await signedIn.reload();
  await expect(tile).toHaveClass(/lg:col-span-2/);
});

test('the period is in the URL and survives leaving the page', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  await signedIn.getByRole('radio', { name: 'YTD' }).click();
  await expect(signedIn).toHaveURL(/window=ytd/);

  // Away and back the way somebody actually leaves. Insights reset to thirty
  // days on exactly this journey. `exact` because the backlog pill's accessible
  // name contains "transactions" too, and Playwright matches a name as a
  // substring — the trap the sidebar locator was fixed for once already.
  await signedIn.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(signedIn.getByRole('heading', { name: 'Transactions' })).toBeVisible();

  await signedIn.goBack();
  await expect(signedIn).toHaveURL(/window=ytd/);
  await expect(signedIn.getByRole('radio', { name: 'YTD' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('a tile shows its empty state when there is nothing in it', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  /*
   * Two different emptinesses, and the page has to tell them apart.
   *
   * The default period is the cycle, and a household that has never pressed
   * Delegate has no cycle to report on — which is not the same as a cycle with
   * nothing spent in it. One of those should show every transaction and the
   * other should show none, so a null start date alone could never carry both.
   */
  await expect(signedIn.getByText('No cycle has been run yet.')).toBeVisible();
  await expect(signedIn.getByText('Nothing waiting.')).toBeVisible();
});

test('the arrange controls are hidden until asked for', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  await signedIn.getByRole('button', { name: 'Done' }).click();

  // Arranging is an occasional act. The tools are not part of reading the page.
  await expect(
    signedIn.getByRole('button', { name: 'Move Spending by grouping earlier' }),
  ).toHaveCount(0);
  await expect(signedIn.getByRole('heading', { name: 'Spending by grouping' })).toBeVisible();
});
