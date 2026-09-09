import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

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
  // The card is not itself a button: a card that is a button cannot contain
  // one, and some tiles draw controls of their own. The Add control sits inside
  // it, and the preview beside that.
  const add = signedIn.getByRole('button', { name: 'Add What it is all made of' });
  await expect(add).toBeVisible();
  const card = add.locator('../..');
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
  await backlog.dragTo(spending, {
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
  await backlog.dragTo(zone);

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
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Cashflow', level: 2 }).locator('../..');
  await expect(tile.getByText('Nothing came in yet.')).toBeVisible();
});

test('the figures band draws four numbers and its own picker', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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

test('the donut switches between the plan and the position', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Add Allocation' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Allocation', level: 2 }).locator('../..');

  // Two readings of one subject, which is why they are one tile with a switch
  // rather than two tiles. The plan is the default: it is the proportion that
  // says something about the household rather than about the timing of bills.
  await expect(tile.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
  await expect(tile.getByText('No amounts to delegate yet.')).toBeVisible();

  await tile.getByRole('radio', { name: 'Now' }).click();
  await expect(tile.getByText('Nothing in the envelopes yet.')).toBeVisible();

  // Stored on the tile, so it survives a reload the way the cashflow period does.
  await signedIn.reload();
  await expect(
    signedIn
      .getByRole('heading', { name: 'Allocation', level: 2 })
      .locator('../..')
      .getByRole('radio', { name: 'Now' }),
  ).toHaveAttribute('aria-checked', 'true');
});

test('upcoming says nothing is scheduled rather than drawing an empty list', async ({
  signedIn,
}) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Add Upcoming' }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  const tile = signedIn.getByRole('heading', { name: 'Upcoming', level: 2 }).locator('../..');
  await expect(tile.getByText('Nothing scheduled.')).toBeVisible();
});

test('setting a payday turns the cycle on across the page', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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
  await backlog.dragTo(spending, { targetPosition: { x: 20, y: box.height / 2 } });
  await expect(spending).toHaveClass(/lg:col-span-6/);

  /*
   * Now the top quarter, which means a row of its own. Before this there was no
   * drag gesture for it at all — every drop joined a row, and the only way to
   * separate two tiles was the ⤓ button inside Arrange.
   */
  const joined = (await spending.boundingBox())!;
  await backlog.dragTo(spending, { targetPosition: { x: joined.width / 2, y: 4 } });
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

  // Add a tile, which rewrites the whole layout.
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Add Cashflow' }).click();
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
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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

test('a balance-history tile asks which one before it draws anything', async ({ signedIn }) => {
  await signedIn.goto('/overview');
  await signedIn.getByRole('button', { name: 'Arrange', exact: true }).click();
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
