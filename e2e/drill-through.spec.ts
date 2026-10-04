import type { APIRequestContext } from '@playwright/test';
import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * A figure opens the register on exactly the rows it adds up (ADR 077).
 *
 * The claim is the reconciliation, not the link: a register that opened on
 * roughly the right rows would pass a test that only checked it navigated.
 */

async function spend(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
): Promise<string> {
  const response = await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt: new Date().toISOString() },
  });
  const body = (await response.json()) as { transaction: { id: string } };
  return body.transaction.id;
}

test('a spending row opens its rows, a split counted at its share, and says it matches', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday', 'asset', 500_000n);
  const groceries = await makeDelegation(api, 'Groceries');
  const household = await makeDelegation(api, 'Household');

  const kroger = await spend(api, accountId, '-8412', 'KROGER #123');
  await api.post(`/api/transactions/${kroger}/categorize`, { data: { delegationId: groceries } });
  const costco = await spend(api, accountId, '-10000', 'COSTCO WHSE #0412');
  await api.post(`/api/transactions/${costco}/categorize`, {
    data: {
      allocations: [
        { delegationId: groceries, amountCents: '-7000' },
        { delegationId: household, amountCents: '-3000' },
      ],
    },
  });

  await signedIn.goto('/overview');
  const tile = signedIn
    .getByRole('heading', { name: 'Spending by delegation', level: 2 })
    .locator('../..');
  // No Delegate run yet, so the cycle holds nothing; thirty days holds both.
  await tile.getByRole('radio', { name: '30D' }).click();
  await tile.getByRole('link', { name: /Groceries/ }).click();

  await expect(signedIn).toHaveURL(/\/transactions\?/);
  // Said on the page, and each one takes itself off.
  await expect(signedIn.getByRole('button', { name: 'Groceries ✕' })).toBeVisible();
  await expect(signedIn.getByRole('button', { name: 'Spending ✕' })).toBeVisible();

  // The split row shows the part that went to Groceries, over the whole charge.
  const split = signedIn.getByRole('row').filter({ hasText: 'COSTCO WHSE #0412' });
  await expect(split).toContainText('-$70.00');
  await expect(split).toContainText('of -$100.00');

  // And the rows add up to the bar, to the cent.
  await expect(signedIn.getByText('Matches Groceries on Spending by delegation')).toBeVisible();
  await expect(signedIn.getByText('2 rows')).toBeVisible();
  await expect(signedIn.getByText('-$154.12', { exact: true })).toBeVisible();

  // Taking a filter off means the list is no longer the figure's, so it stops
  // saying it is.
  await signedIn.getByRole('button', { name: 'Groceries ✕' }).click();
  await expect(signedIn.getByText(/^Matches /)).toHaveCount(0);
});
