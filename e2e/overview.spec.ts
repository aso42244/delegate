import {
  expect,
  makeAccount,
  makeDelegation,
  makeIncome,
  makePendingSpend,
  test,
} from './fixtures.js';

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

/**
 * Arrange, from a page this spec chose rather than from the default.
 *
 * Overview defaults to an arrangement now. A spec about *arranging* that starts
 * from it is asserting against whatever this release's default happens to be,
 * and every one of them would move the day the default does — so these empty it
 * first. Saving an empty layout is a real act: it records that this person has
 * arranged Overview, which is what stops the default standing in again.
 */
async function openArrange(page: import('@playwright/test').Page): Promise<void> {
  const response = await page.request.put('/api/overview/layout', { data: { tiles: [] } });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
}

/** Both proof tiles, so the grid has something in it to arrange. */
async function addBothTiles(page: import('@playwright/test').Page): Promise<void> {
  await openArrange(page);
  await page.getByRole('button', { name: 'Add Spending by grouping' }).click();
  await expect(page.getByRole('heading', { name: 'Spending by grouping', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Add Waiting to be categorized' }).click();
  await expect(
    page.getByRole('heading', { name: 'Waiting to be categorized', level: 2 }),
  ).toBeVisible();
}

test('starts on an arrangement rather than an empty page', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();

  /*
   * Overview is the landing page, so this is the first thing anybody sees. An
   * empty dashboard and a picker to discover was reasonable while the page was
   * reachable by URL only; as a landing page it is a blank screen with a button
   * on it.
   */
  await expect(signedIn.getByText('No tiles yet.')).toHaveCount(0);
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }),
  ).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Cashflow', level: 2 })).toBeVisible();
  // The sidebar is used, not only the grid.
  await expect(signedIn.getByRole('heading', { name: 'Daily outflow', level: 2 })).toBeVisible();
});

test('the default arrangement is not written until somebody changes it', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }),
  ).toBeVisible();

  /*
   * A default that stored itself on first sight would freeze this release's
   * arrangement onto every household, so a later default could never reach
   * anybody — the same reasoning as the landing page's null. The proof visible
   * from here is that it is identical after a reload, having never been saved.
   */
  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }),
  ).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Allocation', level: 2 })).toBeVisible();
});

test('three tiles fit one row on a wide screen', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  /*
   * Three, and it is arithmetic rather than a preference: a ranked bar with a
   * name and a figure stops being readable at about 300px, the page caps at
   * 1600 and the budget panel takes 398 of it. The default's top row is three
   * wide, so each of them is a third of twelve columns.
   */
  const spending = signedIn
    .getByRole('heading', { name: 'Spending by grouping', level: 2 })
    .locator('../..');
  await expect(spending).toHaveClass(/lg:col-span-4/);
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
  await openArrange(signedIn);

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
    'Utilities: Spent vs. Delegated',
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
  await openArrange(signedIn);
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
  await openArrange(signedIn);

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
  await openArrange(signedIn);

  /*
   * A picker listing titles as words asks people to choose between things they
   * cannot see. The composition card is the clearest case: its figures come from
   * `/api/overview/preview`, which is the one deliberate exception to the
   * endpoint's "only what you have" rule — by definition nobody has a tile they
   * are deciding whether to add.
   */
  // The card is not itself a button: a card that is a button cannot contain
  // one, and some tiles draw controls of their own. The Add control sits inside
  // it, and the preview beside that.
  const add = signedIn.getByRole('button', { name: 'Add What it is all made of' });
  await expect(add).toBeVisible();
  const card = add.locator('../..');
  await expect(card.getByText('$2,500.00', { exact: true })).toBeVisible();
});

/*
 * The "empty once, not twice" test that stood here is gone with the state it
 * guarded.
 *
 * It caught a header subtitle and an empty state both reading "No tiles yet." —
 * the text budget broken in the plainest way. The subtitle was removed in
 * v0.61.0 and the page now opens on a default arrangement, so the sentence
 * appears only for somebody who has emptied Overview on purpose, where it is the
 * only thing on screen and cannot be said twice.
 */

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
   * Both bodies present before anything is measured.
   *
   * The headings appear as soon as a tile is added; the bodies arrive with the
   * next data fetch and change the tile's height when they do. Measuring a box
   * before that lands, then dragging to a point inside it, gives Playwright a
   * target that moves out from under the pointer — which it waits on until the
   * test times out rather than failing at the assertion. The rule this follows
   * is the suite's own: after an action that triggers a write, assert on the
   * resulting state before the next action.
   */
  await expect(spending.getByText('No cycle has been run yet.')).toBeVisible();
  await expect(backlog.getByText('Nothing waiting.')).toBeVisible();

  /*
   * Dragging works on the page itself, not only inside Arrange. The buttons
   * stay the route that always works — this is the fast one, and it is the
   * reason a grip is drawn on hover: a card that moves when dragged with
   * nothing to suggest it would is a surprise rather than a feature.
   */
  /*
   * Dropped on the left half, vertically centred. The top and bottom quarters
   * now mean "a row of its own", so a drop meant to *join* a row has to land in
   * the middle band — which is the larger target precisely because joining is
   * the commoner act.
   */
  const box = (await spending.boundingBox())!;
  // From the grip, which is the only thing that starts a drag now.
  await backlog.locator('[data-grip]').dragTo(spending, {
    targetPosition: { x: 20, y: box.height / 2 },
  });

  await expect(spending).toHaveClass(/lg:col-span-6/);
  await expect(backlog).toHaveClass(/lg:col-span-6/);

  // The risk an optimistic write introduces is one that never reaches the
  // server: perfect on screen until the page is loaded again.
  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }).locator('../..'),
  ).toHaveClass(/lg:col-span-6/);
});

test('a tile dragged into the empty sidebar stays there across a reload', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const backlog = signedIn
    .getByRole('heading', { name: 'Waiting to be categorized', level: 2 })
    .locator('../..');
  await expect(backlog.getByText('Nothing waiting.')).toBeVisible();

  /*
   * The sidebar's only way in, while it holds nothing of its own.
   *
   * It used to be an 8px sliver, and the owner's report is what a target that
   * small produces: the tile appears to move, the write never happens, and the
   * refresh puts it back where it started. Nothing failed and nothing said so.
   */
  const zone = signedIn.getByText('Drag a tile here');
  await expect(zone).toBeVisible();
  await backlog.locator('[data-grip]').dragTo(zone);

  await expect(signedIn.getByText('Drag a tile here')).toHaveCount(0);

  // The whole point: a drop that only looked like it worked is the defect.
  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Waiting to be categorized', level: 2 }),
  ).toBeVisible();
  await expect(signedIn.getByText('Drag a tile here')).toHaveCount(0);
});

test('the panel picks its lines in a dialog, and they survive a reload', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Fuel');

  await signedIn.goto('/overview');

  /*
   * The panel is docked and always present — it is not a tile and is never
   * added from the picker. Its lines are chosen from the panel itself, which is
   * also why the selection can exist on a page holding no tiles at all.
   */
  const panel = signedIn.getByRole('complementary', { name: 'Budget' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No delegations chosen yet.')).toBeVisible();

  await panel.getByRole('button', { name: 'Choose which delegations show →' }).click();
  const dialog = signedIn.getByRole('dialog');
  await dialog.getByRole('switch', { name: 'Show Grocery' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(panel.getByText('Grocery')).toBeVisible();
  await expect(panel.getByText('Fuel')).toHaveCount(0);

  // The risk an optimistic write introduces is one that never reaches the
  // server: perfect on screen until the page is loaded again.
  await signedIn.reload();
  await expect(
    signedIn.getByRole('complementary', { name: 'Budget' }).getByText('Grocery'),
  ).toBeVisible();
});

test('the picker lists delegations under their groupings, in the budget order', async ({
  signedIn,
  api,
}) => {
  // Named so alphabetical and positional order disagree: the owner's groupings
  // are "3 - Food" and "5 - Home" precisely because ordering was the thing
  // missing, and a picker that sorted by name would undo that.
  await makeDelegation(api, 'Zucchini');
  await makeDelegation(api, 'Apples');

  await signedIn.goto('/overview');
  await signedIn
    .getByRole('complementary', { name: 'Budget' })
    .getByRole('button', { name: 'Choose which delegations show →' })
    .click();

  const dialog = signedIn.getByRole('dialog');
  // A 1:1 mirror because it reads `GET /api/budget` — the same call, the same
  // cache entry and the same ordering the Budget page draws.
  await expect(dialog.getByRole('switch', { name: 'Show Zucchini' })).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Show Apples' })).toBeVisible();
  await expect(dialog.getByText('No grouping')).toBeVisible();
});

test('the panel says there is no cycle pace until a payday is set', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  /*
   * No anchor means no tick, and the panel says so rather than drawing an empty
   * progress bar — an empty bar reads as "nothing has happened yet", which is a
   * different and wrong answer.
   */
  await expect(signedIn.getByText('No payday set')).toBeVisible();
});

test('the panel is always there', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  /*
   * It used to collapse to a button, per device. The answer somebody opens this
   * page for should not be behind one, and the width it gave back is the width
   * the dashboard is laid out for — so there is no control here to find.
   */
  await expect(signedIn.getByRole('complementary', { name: 'Budget' })).toBeVisible();
  await expect(signedIn.getByRole('button', { name: /collapse the budget panel/i })).toHaveCount(0);
});

test('the cashflow chart carries its own period, separate from the page', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
  await expect(signedIn.getByRole('heading', { name: 'Cashflow', level: 2 })).toBeVisible();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Cashflow', level: 2 }).locator('../..');

  /*
   * The page's control and the chart's are two different controls, and the
   * chart's defaults to year-to-date — a fortnight of cashflow is mostly one
   * paycheck and one rent payment.
   */
  await expect(tile.getByRole('radio', { name: 'YTD' })).toHaveAttribute('aria-checked', 'true');
  await expect(signedIn.getByRole('radio', { name: 'Cycle' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await tile.getByRole('radio', { name: '30D' }).click();
  await expect(tile.getByRole('radio', { name: '30D' })).toHaveAttribute('aria-checked', 'true');

  // The page's period is untouched by the chart's.
  await expect(signedIn.getByRole('radio', { name: 'Cycle' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await signedIn.reload();
  await expect(
    signedIn
      .getByRole('heading', { name: 'Cashflow', level: 2 })
      .locator('../..')
      .getByRole('radio', { name: '30D' }),
  ).toHaveAttribute('aria-checked', 'true');
});

test('the cashflow chart says nothing came in rather than drawing an empty flow', async ({
  signedIn,
}) => {
  await signedIn.goto('/overview?window=ytd');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Cashflow', level: 2 }).locator('../..');
  await expect(tile.getByText('Nothing came in yet.')).toBeVisible();
});

test('the figures band draws four numbers and its own picker', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Figures' }).click();
  await expect(signedIn.getByRole('heading', { name: 'Figures', level: 2 })).toBeVisible();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Figures', level: 2 }).locator('../..');

  /*
   * One tile drawing four figures, not four tiles. A row holds two, so four
   * separate tiles would take two full rows and fill the first screen before a
   * chart appeared.
   */
  await expect(tile.getByText('Inflow')).toBeVisible();
  await expect(tile.getByText('Spent')).toBeVisible();
  await expect(tile.getByText('Left to spend')).toBeVisible();
  await expect(tile.getByText('Uncategorized')).toBeVisible();

  await tile.getByRole('button', { name: 'Choose which figures show →' }).click();
  const dialog = signedIn.getByRole('dialog');

  // Four chosen, so the rest are refused rather than hidden — the cap reads as
  // a state somebody reached, not as options that vanished.
  await expect(dialog.getByRole('switch', { name: 'Show Net worth' })).toBeDisabled();

  await dialog.getByRole('switch', { name: 'Show Uncategorized' }).click();
  await dialog.getByRole('switch', { name: 'Show Net worth' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(tile.getByText('Net worth')).toBeVisible();
  await expect(tile.getByText('Uncategorized')).toHaveCount(0);

  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Figures', level: 2 }).locator('../..'),
  ).toContainText('Net worth');
});

test('a figure with no answer draws a dash, never a confident zero', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Figures' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Figures', level: 2 }).locator('../..');
  await tile.getByRole('button', { name: 'Choose which figures show →' }).click();
  const dialog = signedIn.getByRole('dialog');

  // Clear the band, then take the one figure that has no answer without a
  // payday anchor.
  for (const label of ['Inflow', 'Spent', 'Left to spend', 'Uncategorized']) {
    await dialog.getByRole('switch', { name: `Show ${label}` }).click();
  }
  await dialog.getByRole('switch', { name: 'Show Safe per day' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();

  // No anchor means no cycle to spread it over. A $0.00 would be a different
  // and wrong claim.
  await expect(tile.getByText('—')).toBeVisible();
});

test('the cycle-shaped tiles say they need a payday rather than guessing one', async ({
  signedIn,
}) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add In against out' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * Measured from payday, and there is no anchor. A pace line drawn from a
   * guessed payday would be a picture of the wrong fortnight, so it draws
   * nothing at all rather than something plausible.
   *
   * The outflow band is deliberately not in this test: it is the calendar month
   * and needs no anchor.
   */
  await expect(
    signedIn.getByText('Set your next payday on Settings → Budget to see this cycle.'),
  ).toHaveCount(1);
});

test('the allocation tile switches between what is held and what is delegated', async ({
  signedIn,
}) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Allocation' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Allocation', level: 2 }).locator('../..');

  /*
   * Two readings of one subject, which is why they are one tile with a switch
   * rather than two tiles. Current is the default and sits first: it is the one
   * somebody is usually asking about, where Delegations is a decision they
   * already made.
   *
   * The switch is in the tile's header, beside the title, where every tile's own
   * control sits — in the body it stretched to the tile's full width, because a
   * flex column stretches its children.
   */
  await expect(tile.getByRole('radio', { name: 'Current' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(tile.getByText('Nothing in the envelopes yet.')).toBeVisible();

  /*
   * Both readings arrived with the page, so this is a local switch. It used to
   * write the layout and wait for the whole page to be recomputed before the
   * donut redrew — about a second, for a toggle whose data was already here.
   */
  await tile.getByRole('radio', { name: 'Delegations' }).click();
  await expect(tile.getByText('No amounts to delegate yet.')).toBeVisible();

  // Still stored on the tile, so it survives a reload the way the cashflow
  // period does — the write simply is not what the drawing waits on.
  await signedIn.reload();
  await expect(
    signedIn
      .getByRole('heading', { name: 'Allocation', level: 2 })
      .locator('../..')
      .getByRole('radio', { name: 'Delegations' }),
  ).toHaveAttribute('aria-checked', 'true');
});

test('upcoming says nothing is scheduled rather than drawing an empty list', async ({
  signedIn,
}) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Coming up' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Coming up', level: 2 }).locator('../..');
  await expect(tile.getByText('Nothing scheduled.')).toBeVisible();
});

test('setting a payday turns the cycle on across the page', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add In against out' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * Nothing to draw yet: the cadence says how many paychecks a year arrive and
   * nothing about when, so there is no cycle to measure a pace against. The
   * outflow band is deliberately not here — it is the calendar month and needs
   * no anchor.
   *
   * Scoped to the tile and the panel rather than the page: the Arrange picker
   * draws previews of the other cycle-shaped tiles, which say the same thing for
   * the same reason, so an unscoped locator matches whatever happens to be open.
   */
  const band = signedIn.getByRole('heading', { name: 'In against out', level: 2 }).locator('../..');
  await expect(
    band.getByText('Set your next payday on Settings → Budget to see this cycle.'),
  ).toBeVisible();
  await expect(
    signedIn.getByRole('complementary', { name: 'Budget' }).getByText('No payday set'),
  ).toBeVisible();

  await signedIn.goto('/settings/budget');
  await signedIn.getByLabel('Next payday').fill('2099-01-15');
  // Saved on change, like the cadence beside it.
  await expect(signedIn.getByText('Every other payday is worked out from this one.')).toBeVisible();

  await signedIn.goto('/overview');

  /*
   * One date, and every boundary around it follows. The panel now says where the
   * household sits between paydays, and the band has a cycle to draw.
   */
  // No "of 14": the cadence is a divisor and the length falls out of the
  // anchor, so it told the household a number it already knows.
  await expect(signedIn.getByText(/day \d+ · \d+% through/)).toBeVisible();
  await expect(
    signedIn
      .getByRole('heading', { name: 'In against out', level: 2 })
      .locator('../..')
      .getByText('Set your next payday on Settings → Budget to see this cycle.'),
  ).toHaveCount(0);
});

test('the panel leaves out accounts with nothing in them', async ({ signedIn }) => {
  // A closed-but-not-archived card is the commonest of these, and an account at
  // zero is one nothing can be decided about. The total is unchanged either way,
  // because adding zero changes nothing.
  await makeAccount('Everyday Checking', 'asset', 500_00n);
  await makeAccount('Old Savings', 'asset', 0n);

  await signedIn.goto('/overview');
  const panel = signedIn.getByRole('complementary', { name: 'Budget' });
  await panel.getByRole('radio', { name: 'Accounts' }).click();

  await expect(panel.getByText('Everyday Checking')).toBeVisible();
  await expect(panel.getByText('Old Savings')).toHaveCount(0);
});

test('the panel lists only accounts the budget counts', async ({ signedIn }) => {
  // A house is net worth, not money this budget can allocate. ADR 050 made that
  // boundary a wall after three places crossed it, and this panel is the
  // budget's — so it stands on the same side.
  await makeAccount('Everyday Checking', 'asset', 500_00n);
  await makeAccount('The house', 'asset', 35_000_000n, 'manual', null, { inBudget: false });

  await signedIn.goto('/overview');
  const panel = signedIn.getByRole('complementary', { name: 'Budget' });
  await panel.getByRole('radio', { name: 'Accounts' }).click();

  await expect(panel.getByText('Everyday Checking')).toBeVisible();
  await expect(panel.getByText('The house')).toHaveCount(0);

  // And the total says what it counted, because a figure that silently excluded
  // a house is one somebody trusts and should not.
  await expect(panel.getByText('Accounts in the budget')).toBeVisible();
});

test('a tile can be dropped onto its own row, and at the very top', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const spending = signedIn
    .getByRole('heading', { name: 'Spending by grouping', level: 2 })
    .locator('../..');
  const backlog = signedIn
    .getByRole('heading', { name: 'Waiting to be categorized', level: 2 })
    .locator('../..');

  // Both bodies present before anything is measured — see the note in the drag
  // test above; a tile whose height is still settling is a target that moves.
  await expect(spending.getByText('No cycle has been run yet.')).toBeVisible();
  await expect(backlog.getByText('Nothing waiting.')).toBeVisible();

  // Join first, so there is a row to be split by dragging rather than by ⤓.
  const box = (await spending.boundingBox())!;
  await backlog.locator('[data-grip]').dragTo(spending, {
    targetPosition: { x: 20, y: box.height / 2 },
  });
  await expect(spending).toHaveClass(/lg:col-span-6/);

  /*
   * Now the top quarter, which means a row of its own. Before this there was no
   * drag gesture for it at all — every drop joined a row, and the only way to
   * separate two tiles was the ⤓ button inside Arrange.
   */
  const joined = (await spending.boundingBox())!;
  await backlog.locator('[data-grip]').dragTo(spending, {
    targetPosition: { x: joined.width / 2, y: 4 },
  });
  await expect(spending).toHaveClass(/lg:col-span-12/);
  await expect(backlog).toHaveClass(/lg:col-span-12/);

  await signedIn.reload();
  await expect(
    signedIn.getByRole('heading', { name: 'Spending by grouping', level: 2 }).locator('../..'),
  ).toHaveClass(/lg:col-span-12/);
});

test('the panel keeps its delegations when tiles are rearranged', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/overview');
  const panel = signedIn.getByRole('complementary', { name: 'Budget' });
  await panel.getByRole('button', { name: 'Choose which delegations show →' }).click();
  const dialog = signedIn.getByRole('dialog');
  await dialog.getByRole('switch', { name: 'Show Grocery' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('Grocery')).toBeVisible();

  // Arranged from the default rather than from an emptied page: emptying is
  // itself an arrange, and it would throw away the choice just made — which is
  // the very thing this test is about keeping.
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  // A tile the default does not already carry, so the picker offers it.
  await signedIn.getByRole('button', { name: 'Add What moved' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * The panel's row is filtered out of the grid because the panel draws it, so
   * every arrange operation used to write a layout without it — silently
   * deleting the chosen delegations the moment anybody moved a tile. Nothing
   * failed and nothing said so, which is the worst kind of loss.
   */
  await expect(panel.getByText('Grocery')).toBeVisible();
  await signedIn.reload();
  await expect(
    signedIn.getByRole('complementary', { name: 'Budget' }).getByText('Grocery'),
  ).toBeVisible();
});

test('the panel summary says what there is, what has gone and what is left', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/overview');
  const panel = signedIn.getByRole('complementary', { name: 'Budget' });
  await panel.getByRole('button', { name: 'Choose which delegations show →' }).click();
  const dialog = signedIn.getByRole('dialog');
  await dialog.getByRole('switch', { name: 'Show Grocery' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();

  /*
   * The three subtract: what the lines had this cycle, less what has gone, is
   * what is left. It said "Budgeted" — the sum of the amounts to delegate, which
   * is what a press puts in rather than what there is, and on lines carrying
   * surplus it came out *smaller* than Remaining.
   */
  await expect(panel.getByText('To spend')).toBeVisible();
  await expect(panel.getByText('Spent')).toBeVisible();
  await expect(panel.getByText('Remaining')).toBeVisible();

  // Spent-against-budgeted is on the bar's own tooltip rather than beside it,
  // so the name gets the width those two figures were taking.
  await expect(panel.getByTitle(/spent of/)).toBeVisible();
});

test('the outflow band draws the calendar month with no payday set', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Daily outflow' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * The one reading here that is not cycle-shaped. Days belong to months — bills
   * arrive on dates and statements close on dates — so this works on a household
   * that has never set a payday, unlike everything else measured from one.
   */
  const tile = signedIn.getByRole('heading', { name: 'Daily outflow', level: 2 }).locator('../..');
  await expect(
    tile.getByText('Set your next payday on Settings → Budget to see this cycle.'),
  ).toHaveCount(0);

  /*
   * This month and the two before it, each row naming its own month and
   * carrying its own total. One band says how this month is going and nothing
   * about whether that is unusual, which is the question a spending pattern is
   * actually asked.
   */
  await expect(tile.getByText(/out · avg/)).toHaveCount(3);
  // One band per month, each labelled with its own month and day count. The
  // name is asserted through the band's own label rather than built here, so
  // the test does not depend on the browser's locale matching Node's.
  await expect(tile.getByRole('img', { name: /over \d+ days/ })).toHaveCount(3);
});

test('a day on the outflow band opens what was spent that day', async ({ signedIn, api }) => {
  const account = await makeAccount('Everyday Checking', 'asset', 500_00n);
  const delegationId = await makeDelegation(api, 'Groceries');
  await makePendingSpend(account, delegationId, -42_10n, 'Corner shop');
  // Money in, on the same day, which the band does not count.
  await makeIncome(account, 1_500_00n, 'Payday');

  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Daily outflow' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Daily outflow', level: 2 }).locator('../..');

  /*
   * The band says a day cost $42.10 and the next question is always which
   * $42.10. Days with nothing on them are disabled rather than hidden — the
   * shape of the month depends on their cells — so the only enabled one is the
   * day this charge landed.
   */
  /*
   * Enabled even though the household's zone may have filed it on a date the
   * browser has not reached yet.
   *
   * The API cuts its day keys in the household's zone and the interface compares
   * them against the browser's — two clocks that can disagree by a day. A charge
   * posted this evening landed on a cell drawn as "not yet" and disabled, so the
   * day somebody most wants to open was the one they could not. A day with money
   * on it has happened, whatever the calendar here says.
   */
  const day = tile.getByRole('button', { name: /\$42\.10/ });
  await expect(day).toBeEnabled();
  await day.click();

  const dialog = signedIn.getByRole('dialog');
  await expect(dialog.getByText('Corner shop')).toBeVisible();
  await expect(dialog.getByText('Groceries')).toBeVisible();
  await expect(dialog.getByText('$42.10 out')).toBeVisible();

  /*
   * The pay that landed the same day is not that day's spending, and neither is
   * a card payment. The band counts neither, so listing them here put a credit
   * in a list headed by what went out with a total that agreed with neither.
   */
  await expect(dialog.getByText('Payday')).toHaveCount(0);

  // A reading closes when you press outside it. A dialog holding a typed amount
  // still does not — that would lose the typing to a stray click.
  await signedIn.mouse.click(5, 5);
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
});

test('a tile dragged by its body does not move', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await addBothTiles(signedIn);
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const spending = signedIn
    .getByRole('heading', { name: 'Spending by grouping', level: 2 })
    .locator('../..');
  const backlog = signedIn
    .getByRole('heading', { name: 'Waiting to be categorized', level: 2 })
    .locator('../..');
  await expect(spending.getByText('No cycle has been run yet.')).toBeVisible();
  await expect(backlog.getByText('Nothing waiting.')).toBeVisible();

  /*
   * The whole card used to be the handle, so a press on a chart or on a label
   * somebody meant to select began a drag. Dragging from the body is now refused
   * at `dragstart`, and the arrangement is untouched — each tile still has its
   * own row and so still spans all twelve columns.
   */
  const box = (await spending.boundingBox())!;
  await backlog.dragTo(spending, { targetPosition: { x: 20, y: box.height / 2 } });

  await expect(spending).toHaveClass(/lg:col-span-12/);
  await expect(backlog).toHaveClass(/lg:col-span-12/);
});

test('the bill tiles open every bill in the middle of the page', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Needs a look' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Needs a look', level: 2 }).locator('../..');

  /*
   * Empty most weeks, and that is the point of it: a tile saying "everything
   * arrived" most days and naming three things on the day something slipped is
   * worth more of a dashboard than one saying the same thing every day.
   */
  await expect(tile.getByText('Everything arrived')).toBeVisible();

  /*
   * A dialog rather than a link away. Somebody reading "three bills need a look"
   * wants the other twenty in front of them, not a page change and a way back.
   */
  await tile.getByRole('button', { name: 'All bills →' }).click();
  const dialog = signedIn.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'All bills' })).toBeVisible();
  await expect(dialog.getByText('No bill has arrived three times yet.')).toBeVisible();
  // Changing a bill is still Recurring's job; this is a read.
  await expect(dialog.getByRole('link', { name: 'Open Recurring →' })).toBeVisible();
});

test('the utility tiles say they do not know rather than guessing', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Which way they’re going' }).click();
  await signedIn.getByRole('button', { name: 'Add Worth adjusting' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const trend = signedIn
    .getByRole('heading', { name: 'Which way they’re going', level: 2 })
    .locator('../..');

  /*
   * A dash, not 0%. Two years of history is what a seasonal bill needs before
   * one year can be compared with another, and a household without it is told
   * that rather than shown a confident flat line.
   */
  await expect(trend.getByText('Water')).toBeVisible();
  await expect(trend.getByText('—', { exact: true })).toBeVisible();

  const adjust = signedIn
    .getByRole('heading', { name: 'Worth adjusting', level: 2 })
    .locator('../..');
  // Nothing spent, so nothing to compare a funding level against.
  await expect(adjust.getByText('Nothing to change')).toBeVisible();
});

test('a row keeps the height it was dragged to', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Cashflow', level: 2 }).locator('../..');
  await expect(tile).toBeVisible();

  /*
   * Dragging is not reachable by keyboard, so the handle takes the arrows —
   * which is also the route a test can drive without simulating a pointer
   * gesture. Each press is 24px, a height somebody can actually land on.
   *
   * **One press, and then wait for it.** Every press is its own write, so four
   * in a row race each other and a height measured straight after the loop
   * catches whichever had landed — which is how this failed the first time,
   * expecting 144 against a stored 168.
   */
  const handle = signedIn.getByRole('separator', { name: /Height of the row/ });
  const before = Math.round((await tile.boundingBox())!.height);
  await handle.focus();
  await handle.press('ArrowDown');

  const taller = before + 24;
  await expect.poll(async () => Math.round((await tile.boundingBox())!.height)).toBe(taller);

  /*
   * Stored on every tile in the row, so it survives the reload that proves the
   * write landed rather than only the optimistic update. Polled again, because
   * a box measured the instant after a reload is measured while the layout
   * query is still in flight and the tile is at its natural height.
   */
  await signedIn.reload();
  const reloadedTile = signedIn
    .getByRole('heading', { name: 'Cashflow', level: 2 })
    .locator('../..');
  await expect(reloadedTile).toBeVisible();
  await expect
    .poll(async () => Math.round((await reloadedTile.boundingBox())!.height))
    .toBe(taller);
});

test('a row dragged short fits its content rather than clipping it', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
  await signedIn.getByRole('button', { name: 'Add Allocation' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const handle = signedIn.getByRole('separator', { name: /Height of the row/ }).first();
  await handle.focus();
  for (let press = 0; press < 12; press += 1) await handle.press('ArrowUp');

  /*
   * The tile's body clips, so anything overflowing it is unreachable rather
   * than merely below the fold — which is what a dragged-short row did on the
   * first cut: the Sankey kept its full height and scrolled, the donut was
   * clipped halfway, and rows of the spending lists were simply gone.
   *
   * A chart scales to the room it is given and a list scrolls in place, so the
   * body itself never overflows. That is the property, and it is measurable.
   */
  const overflow = await signedIn.evaluate(() =>
    [...document.querySelectorAll('section[data-tile] > div:last-of-type')].map((element) => ({
      tile: (element.closest('section') as HTMLElement).dataset['tile'],
      over: element.scrollHeight - element.clientHeight,
    })),
  );

  expect(overflow.length).toBeGreaterThan(0);
  for (const entry of overflow) expect(entry.over).toBeLessThanOrEqual(1);
});

test('the outstanding checks tile lists what has not cleared', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Outstanding checks' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn
    .getByRole('heading', { name: 'Outstanding checks', level: 2 })
    .locator('../..');
  // Nothing written yet, said plainly rather than drawn as an empty list.
  await expect(tile.getByText('Nothing outstanding.')).toBeVisible();
});

test('a balance-history tile asks which one before it draws anything', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Account balance' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  /*
   * The picker offers only accounts that have history, so it can never point at
   * something that draws an empty box. On a household whose snapshots start at
   * the first night that means it offers nothing at all — and says so, rather
   * than showing an empty control somebody would fiddle with.
   */
  const tile = signedIn
    .getByRole('heading', { name: 'Account balance', level: 2 })
    .locator('../..');
  await expect(tile.getByText('No account has history yet.')).toBeVisible();
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

/*
 * The chart fits its tile, at every size, in both directions.
 *
 * Three separate defects live behind this one test, and each was visible on the
 * owner's screen before it was visible here.
 *
 * **It used to be scaled to fit**, which `preserveAspectRatio` does by moving
 * both dimensions together: a shorter row drew a postage stamp between two bands
 * of white, in a tile exactly as wide as before. It is laid out *to* the room
 * now, so the width is always the tile's width.
 *
 * **Then it was measured off the page** — first from the chart's own container,
 * then from the tile body around it — and both fed back, because the box is as
 * tall as the drawing inside it. It reached 3,883px from a row dragged shorter.
 * The height is a stored number now; see `tile-height.ts`.
 *
 * **And then it was reliably too tall anyway.** The scale came from the middle
 * bar alone, and each column added its gaps and slot floors on top — about 56
 * units of overflow for eight nodes, clipped off the bottom at every size. The
 * scale is fitted to the columns now, furniture included.
 *
 * So this asserts the property rather than any of the three fixes: the drawing
 * is inside the tile, and as wide as it, however the row is dragged. On the demo
 * route because it has a flow to draw, and because a pointer drag previews live
 * without needing the layout saved.
 */
test('the cashflow chart fits its tile at every height', async ({ signedIn }) => {
  await signedIn.setViewportSize({ width: 1680, height: 1000 });
  await signedIn.goto('/demo/overview');

  const svg = signedIn.locator('svg[role="img"]').first();
  await expect(svg).toBeVisible();

  /** The drawing, and the box it has to stay inside. */
  const boxes = async (): Promise<{
    readonly drawn: { readonly w: number; readonly h: number };
    readonly room: { readonly w: number; readonly h: number };
  }> =>
    svg.evaluate((node) => {
      const body = node.parentElement!.parentElement!;
      const drawn = node.getBoundingClientRect();
      const room = body.getBoundingClientRect();
      return {
        drawn: { w: Math.round(drawn.width), h: Math.round(drawn.height) },
        room: { w: Math.round(room.width), h: Math.round(room.height) },
      };
    });

  const before = await boxes();
  expect(before.drawn.h).toBeLessThanOrEqual(before.room.h);
  expect(before.drawn.w).toBe(before.room.w);

  const handle = signedIn.getByRole('separator', { name: /Height of the row holding Cashflow/ });
  const grip = (await handle.boundingBox())!;
  await signedIn.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await signedIn.mouse.down();

  // Including further than the row can actually go, which is the case that used
  // to clip: the chart must give way rather than overflow.
  for (const drag of [-150, -300, -420]) {
    await signedIn.mouse.move(grip.x + grip.width / 2, grip.y + drag, { steps: 6 });
    await signedIn.waitForTimeout(200);

    const at = await boxes();
    expect(at.drawn.h, `height at drag ${drag}`).toBeLessThanOrEqual(at.room.h);
    expect(at.drawn.w, `width at drag ${drag}`).toBe(at.room.w);
  }

  const shortest = await boxes();
  await signedIn.mouse.up();

  // And it did shorten, rather than fitting by having never changed.
  expect(shortest.drawn.h).toBeLessThan(before.drawn.h);
});

/*
 * A column of percentages is a column.
 *
 * Every row used to carry its own `grid`, so `max-content` on the figure was
 * resolved against that row's figure alone — and every column before it landed
 * wherever that left it. `34%` and `6%` ended eight pixels apart down the same
 * tile, which is the whole thing the share column exists to prevent. The list
 * is one grid now and the rows take its tracks.
 *
 * Asserted as a shared edge rather than by reading text, for the reason the
 * span assertions above give: a test that only looks for words passes just as
 * happily while the layout is wrong.
 */
test('the percentages in a tile share one right edge', async ({ signedIn }) => {
  await signedIn.setViewportSize({ width: 1680, height: 1000 });
  await signedIn.goto('/demo/overview');
  await expect(signedIn.getByRole('heading', { name: 'Allocation', level: 2 })).toBeVisible();

  const edges = await signedIn.evaluate(() => {
    const found: Record<string, number[]> = {};
    for (const cell of Array.from(document.querySelectorAll('li > span.money'))) {
      if (!/^\d{1,3}%$/.test((cell.textContent ?? '').trim())) continue;
      const tile = cell.closest('section[data-tile]')?.querySelector('h2')?.textContent?.trim();
      if (tile === undefined) continue;
      found[tile] = [...(found[tile] ?? []), Math.round(cell.getBoundingClientRect().right)];
    }
    return found;
  });

  // The demo draws three of these, and a run that found none would otherwise
  // pass by having nothing to check.
  expect(Object.keys(edges).length).toBeGreaterThanOrEqual(2);
  for (const [tile, rights] of Object.entries(edges)) {
    expect(rights.length, `${tile} has percentages`).toBeGreaterThan(1);
    expect([...new Set(rights)], `${tile} percentages share an edge`).toHaveLength(1);
  }
});

/*
 * All bills reads like the day dialog, because they are the same kind of list.
 *
 * The cadence and the delegation used to sit on a second line under the name,
 * inside a cell whose height `row-cell` fixes — so the second line overflowed it
 * and struck the divider below. Across, they fit.
 *
 * The assertion is that a row is one line: every cell in it shares a centre. A
 * stacked row fails that by construction, which a text assertion would not.
 */
test('every row of All bills is a single line', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday', 'asset', 250000n);
  const home = await makeDelegation(api, 'Home & Grounds');

  // Three arrivals a month apart is what makes a charge a bill.
  for (const [amountCents, description] of [
    ['-6286', 'BLUEPEAK INTERNET'],
    ['-10853', 'XCEL ENERGY'],
  ] as const) {
    for (let back = 3; back >= 1; back -= 1) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - back * 30);
      await api.post('/api/transactions', {
        data: {
          accountId,
          amountCents,
          description,
          postedAt: `${date.toISOString().slice(0, 10)}T15:00:00Z`,
        },
      });
    }
  }

  const listed = await api.get('/api/transactions?limit=100');
  const body = (await listed.json()) as { transactions: { id: string }[] };
  for (const transaction of body.transactions) {
    await api.post(`/api/transactions/${transaction.id}/categorize`, {
      data: { delegationId: home },
    });
  }

  await signedIn.goto('/overview');
  await openArrange(signedIn);
  await signedIn.getByRole('button', { name: 'Add Needs a look' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  await signedIn.getByRole('button', { name: 'All bills →' }).first().click();
  const dialog = signedIn.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('BLUEPEAK INTERNET')).toBeVisible();

  const rows = await dialog.evaluate((node) =>
    Array.from(node.querySelectorAll('li')).map((row) =>
      Array.from(row.children).map((cell) => {
        const box = cell.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      }),
    ),
  );

  expect(rows.length).toBeGreaterThan(0);
  for (const centres of rows) {
    expect(centres.length).toBeGreaterThan(3);
    // One line: within a pixel of each other, whatever the type sizes are.
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
  }
});
