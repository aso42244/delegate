import { expect, makeAccount, test } from './fixtures.js';

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
  await page.getByRole('button', { name: 'Add Spending by grouping' }).click();
  await expect(page.getByRole('heading', { name: 'Spending by grouping', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Add Waiting to be categorized' }).click();
  await expect(
    page.getByRole('heading', { name: 'Waiting to be categorized', level: 2 }),
  ).toBeVisible();
}

test('starts empty and says so in one sentence', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // The text budget: one short sentence, no instructions. Where to go next is on
  // the control that goes there.
  await expect(signedIn.getByText('No tiles yet.')).toBeVisible();
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

  // Scoped to the tiles: the Arrange panel's own heading is an h2 as well, and
  // it belongs at that level — it is a section of the page, not part of a tile.
  const headings = signedIn.locator('section[data-tile] h2');
  await expect(headings).toHaveText(['Spending by grouping', 'Waiting to be categorized']);

  // Addressed by name rather than by index: every tile's controls name the tile
  // they act on, which is what makes them distinguishable to a screen reader.
  await signedIn.getByRole('button', { name: 'Move Waiting to be categorized earlier' }).click();
  await expect(headings).toHaveText(['Waiting to be categorized', 'Spending by grouping']);

  await signedIn.reload();
  await expect(headings).toHaveText(['Waiting to be categorized', 'Spending by grouping']);
});

test('two tiles in one row each take half the grid', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  const first = signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 });
  const tile = first.locator('../..');

  // Each on its own row to begin with, so each is the full twelve columns.
  await expect(tile).toHaveClass(/lg:col-span-12/);

  /*
   * Measured as a class rather than read as text, the same reason the
   * settings-card overflow needed in v0.49.0: an assertion that only looks for
   * words passes just as happily while the layout is wrong.
   */
  await signedIn
    .getByRole('button', { name: 'Move Waiting to be categorized into the row above' })
    .click();
  await expect(tile).toHaveClass(/lg:col-span-6/);

  await signedIn.reload();
  await expect(tile).toHaveClass(/lg:col-span-6/);
});

test('a tile can be given a row of its own again', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);

  await signedIn
    .getByRole('button', { name: 'Move Waiting to be categorized into the row above' })
    .click();
  const tile = signedIn
    .getByRole('heading', { name: 'Spending by grouping', level: 2 })
    .locator('../..');
  await expect(tile).toHaveClass(/lg:col-span-6/);

  await signedIn
    .getByRole('button', { name: 'Give Waiting to be categorized a row of its own' })
    .click();
  await expect(tile).toHaveClass(/lg:col-span-12/);
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
  // Scoped to the tiles: the Arrange panel draws a preview of every tile that
  // could be added, and several of those say the same sentence — which is the
  // picker working, not a duplicate.
  const tiles = signedIn.locator('section[data-tile]');
  await expect(tiles.getByText('No cycle has been run yet.')).toBeVisible();
  await expect(tiles.getByText('Nothing waiting.')).toBeVisible();
});

test('every Batch A tile can be added and draws something', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();

  /*
   * The five tiles that share one drawing primitive. Added in one pass rather
   * than five tests, because what is being protected is that the catalogue and
   * the renderer agree — a key the server offers and the page cannot draw is a
   * tile that is on the page and blank, which reads as a fault rather than as an
   * empty state.
   */
  const titles = [
    'Spending by grouping',
    'Spending by delegation',
    'What it is all made of',
    'Utilities against what they cost',
    'What moved',
  ];

  for (const title of titles) {
    await signedIn.getByRole('button', { name: `Add ${title}` }).click();
    await expect(signedIn.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  }

  await signedIn.getByRole('button', { name: 'Done' }).click();

  // Every one of them says something. A blank body is the failure this catches.
  for (const title of titles) {
    const tile = signedIn.getByRole('heading', { name: title }).locator('../..');
    await expect(tile).not.toBeEmpty();
  }

  await signedIn.reload();
  await expect(signedIn.locator('section[data-tile] h2')).toHaveCount(titles.length);
});

test('a ranked bar states its figure as text, not only as a width', async ({ signedIn }) => {
  // With no accounts at all the tile correctly shows its empty state instead,
  // so there has to be something to compose.
  await makeAccount('Checking', 'asset', 300_000n);
  await makeAccount('Card', 'debt', 50_000n);

  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Add What it is all made of' }).click();
  await expect(
    signedIn.getByRole('heading', { name: 'What it is all made of', level: 2 }),
  ).toBeVisible();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * §9: never convey state by colour alone — and never by length alone either.
   * The bar is `aria-hidden` because the figure beside it already says the
   * value, so the figure has to actually be there.
   */
  const tile = signedIn.getByRole('heading', { name: 'What it is all made of' }).locator('../..');
  await expect(tile.getByText('Assets')).toBeVisible();
  await expect(tile.getByText('Debts')).toBeVisible();
  await expect(tile.getByText('Net')).toBeVisible();
  // 300,000 cents of asset less 50,000 of debt, stated rather than implied.
  await expect(tile.getByText('$2,500.00', { exact: true })).toBeVisible();
});

test('every Batch B tile draws, and says it has no history yet', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();

  const titles = [
    'Net worth',
    'Assets against debts',
    'Identity drift',
    'What net worth is made of',
    'Bitcoin over time',
    'Home equity',
    'Debt trajectory',
  ];

  for (const title of titles) {
    await signedIn.getByRole('button', { name: `Add ${title}` }).click();
    await expect(signedIn.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  }

  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * A fresh household has no snapshots, so every one of these must say so in a
   * sentence rather than drawing an axis through nothing. Insights ships with no
   * history at all and gains a day a night, so this is the state every one of
   * them is first seen in — and a tile that draws an empty box here reads as
   * broken rather than as new.
   */
  const tiles = signedIn.locator('section[data-tile]');
  await expect(tiles.getByText('No history yet — the first night records one.')).toHaveCount(4);
  await expect(tiles.getByText('No holding recorded yet.')).toBeVisible();
  await expect(tiles.getByText('No property with a mortgage against it.')).toBeVisible();
  await expect(tiles.getByText('Not enough history to project yet.')).toBeVisible();

  await signedIn.reload();
  await expect(signedIn.locator('section[data-tile] h2')).toHaveCount(titles.length);
});

test('the picker draws each tile rather than naming it', async ({ signedIn }) => {
  await makeAccount('Checking', 'asset', 300_000n);
  await makeAccount('Card', 'debt', 50_000n);

  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();

  /*
   * A picker listing titles as words asks people to choose between things they
   * cannot see. The composition card is the clearest case: its figures come from
   * `/api/overview/preview`, which is the one deliberate exception to the
   * endpoint's "only what you have" rule — by definition nobody has a tile they
   * are deciding whether to add.
   */
  const card = signedIn.getByRole('button', { name: 'Add What it is all made of' });
  await expect(card).toBeVisible();
  await expect(card.getByText('$2,500.00', { exact: true })).toBeVisible();
});

test('the page says it is empty once, not twice', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  // The subtitle and the empty state both read "No tiles yet." on the first
  // real screenshot of this page — the text budget broken in the plainest way.
  await expect(signedIn.getByText('No tiles yet.')).toHaveCount(1);
});

test('tiles can be dragged into one row without entering Arrange', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const spending = signedIn
    .getByRole('heading', { name: 'Spending by grouping', level: 2 })
    .locator('../..');
  const backlog = signedIn
    .getByRole('heading', { name: 'Waiting to be categorized', level: 2 })
    .locator('../..');

  // Each on its own row, so each is the full twelve columns.
  await expect(spending).toHaveClass(/lg:col-span-12/);

  /*
   * Dragging works on the page itself, not only inside Arrange. The buttons
   * stay the route that always works — this is the fast one, and it is the
   * reason a grip is drawn on hover: a card that moves when dragged with
   * nothing to suggest it would is a surprise rather than a feature.
   */
  await backlog.dragTo(spending, { targetPosition: { x: 20, y: 20 } });

  await expect(spending).toHaveClass(/lg:col-span-6/);
  await expect(backlog).toHaveClass(/lg:col-span-6/);

  // The risk an optimistic write introduces is one that never reaches the
  // server: perfect on screen until the page is loaded again.
  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }).locator('../..'),
  ).toHaveClass(/lg:col-span-6/);
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
