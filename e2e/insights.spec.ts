import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Insights.
 *
 * A fixed catalog rather than a chart builder, with the choice persisted per
 * user. The behaviour worth protecting is that the page is useful on a first
 * visit rather than blank, and that removing a widget survives a reload.
 */

test('shows the whole catalog before anything has been chosen', async ({ signedIn }) => {
  await signedIn.goto('/insights');

  await expect(signedIn.getByRole('heading', { name: 'Insights' })).toBeVisible();
  // Useful on arrival rather than an empty page with a button on it.
  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Uncategorized' })).toBeVisible();
});

test('a removed widget stays removed across a reload', async ({ signedIn }) => {
  await signedIn.goto('/insights');
  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toBeVisible();

  await signedIn.getByRole('button', { name: 'Remove Assets and debts' }).click();
  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toHaveCount(0);

  await signedIn.reload();
  await expect(signedIn.getByRole('heading', { name: 'Uncategorized' })).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toHaveCount(0);
});

test('a widget can be added back from the catalog', async ({ signedIn }) => {
  await signedIn.goto('/insights');
  await signedIn.getByRole('button', { name: 'Remove Assets and debts' }).click();
  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toHaveCount(0);

  await signedIn.getByRole('button', { name: 'New tile' }).click();
  await signedIn.getByRole('button', { name: 'Assets and debts', exact: true }).click();

  await expect(signedIn.getByRole('heading', { name: 'Assets and debts' })).toBeVisible();
});

test('reports what is held and owed', async ({ signedIn }) => {
  await makeAccount('Everyday Checking', 'asset', 300000n);
  await makeAccount('Card', 'debt', 50000n);

  await signedIn.goto('/insights');

  // $3,000 held less $500 owed.
  await expect(signedIn.getByText('$2,500.00')).toBeVisible();
});

test('names the over-spent lines, and says so when there are none', async ({ signedIn, api }) => {
  const grocery = await makeDelegation(api, 'Grocery');

  await signedIn.goto('/insights');
  await expect(signedIn.getByText('Nothing is over-spent.')).toBeVisible();

  await api.post(`/api/delegations/${grocery}/adjust`, { data: { deltaCents: '-4210' } });
  await signedIn.reload();

  await expect(signedIn.getByText('-$42.10')).toBeVisible();
});

/** Before the first Delegate press there is no cycle, and none is invented. */
test('says there is no cycle rather than showing an empty one', async ({ signedIn }) => {
  await signedIn.goto('/insights');
  await signedIn.getByRole('radio', { name: 'This cycle' }).click();

  await expect(
    signedIn.getByText('No Delegate press yet, so there is no cycle to report on.').first(),
  ).toBeVisible();
});

/**
 * Insights ships with no history and gains a day a night, so the empty state is
 * the state most of these tiles are in on day one. It has to be a sentence
 * rather than an axis drawn through nothing.
 */
test('a chart with no history says so rather than drawing an empty box', async ({ signedIn }) => {
  await makeAccount('Everyday Checking', 'asset', 300000n);
  await signedIn.goto('/insights');

  await expect(signedIn.getByRole('heading', { name: 'Net worth over time' })).toBeVisible();
  await expect(
    signedIn.getByText('No history yet — the first night records one.').first(),
  ).toBeVisible();
});

/** One control drives every tile, and it carries the windows the older ones need. */
test('the range selector offers every window, including cycle and all', async ({ signedIn }) => {
  await signedIn.goto('/insights');

  for (const label of [
    '30 days',
    '90 days',
    '6 months',
    '1 year',
    'Year to date',
    'This cycle',
    'All',
  ]) {
    await expect(signedIn.getByRole('radio', { name: label })).toBeVisible();
  }
});

/**
 * A recorded night puts a figure on the chart. One point is still not a trend,
 * and the tile says which of the two it has.
 */
test('a recorded snapshot reaches the net worth chart', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 300000n);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const run = await api.post('/api/snapshots/run', { data: { date: yesterday } });
  expect(run.ok()).toBe(true);

  await signedIn.goto('/insights');
  await expect(signedIn.getByRole('heading', { name: 'Net worth over time' })).toBeVisible();
  await expect(signedIn.getByText('Only one day of history so far.').first()).toBeVisible();
});

/**
 * The drill-down defaults to groupings and goes down two levels. The breadcrumb
 * is the way back up.
 */
test('the delegation drill-down goes down and comes back', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 300000n);
  await makeDelegation(api, 'Grocery');

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await api.post('/api/snapshots/run', { data: { date: yesterday } });

  await signedIn.goto('/insights');
  const tile = signedIn.getByRole('heading', { name: 'Delegation balances' });
  await expect(tile).toBeVisible();

  // Ungrouped lines are their own series at the top level, named for what they
  // are rather than left out.
  const section = signedIn.locator('section').filter({ has: tile });
  await section.getByRole('button', { name: 'No grouping' }).click();

  // One level down, the delegation itself, with a way back.
  await expect(section.getByRole('button', { name: 'Back' })).toBeVisible();
  await section.getByRole('button', { name: 'Back' }).click();
  await expect(section.getByRole('button', { name: 'No grouping' })).toBeVisible();
});

/** The picker the hardwired credit-card tile never had. */
test('the account balance tile offers a picker', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 300000n);
  await makeAccount('Savings', 'asset', 900000n);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await api.post('/api/snapshots/run', { data: { date: yesterday } });

  await signedIn.goto('/insights');
  const tile = signedIn.getByRole('heading', { name: 'Account balance' });
  await expect(tile).toBeVisible();

  const section = signedIn.locator('section').filter({ has: tile });
  await expect(section.getByRole('combobox', { name: 'Account' })).toBeVisible();
  await section.getByRole('combobox', { name: 'Account' }).selectOption({ label: 'Savings' });
});

test('says what it cannot chart rather than drawing an empty box', async ({ signedIn }) => {
  await signedIn.goto('/insights');

  await expect(
    signedIn.getByText('No property with a mortgage linked to it.', { exact: false }),
  ).toBeVisible();
});
