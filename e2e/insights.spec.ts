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

  await signedIn.getByRole('button', { name: '+ Add from catalog' }).click();
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
  await signedIn.getByRole('button', { name: 'This cycle' }).click();

  await expect(
    signedIn.getByText('No Delegate press yet, so there is no cycle to report on.').first(),
  ).toBeVisible();
});
