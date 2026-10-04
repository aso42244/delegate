import type { APIRequestContext } from '@playwright/test';
import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Month in review (ADR 078): last month, read back, and every sum it shows
 * opens the rows behind it (ADR 077).
 */

/** The middle of last month, so no zone puts it in another one. */
function lastMonth(day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day, 15)).toISOString();
}

async function post(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
  kind: 'normal' | 'income' = 'normal',
): Promise<string> {
  const response = await api.post('/api/transactions', {
    data: { accountId, amountCents, description, kind, postedAt: lastMonth(14) },
  });
  return ((await response.json()) as { transaction: { id: string } }).transaction.id;
}

test('last month adds up, and a line opens exactly what it spent', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday', 'asset', 500_000n);
  const groceries = await makeDelegation(api, 'Groceries');

  await post(api, accountId, '400000', 'PAYROLL', 'income');
  const kroger = await post(api, accountId, '-8412', 'KROGER #123');
  await api.post(`/api/transactions/${kroger}/categorize`, { data: { delegationId: groceries } });
  await post(api, accountId, '-999', 'MYSTERY CHARGE');

  await signedIn.goto('/overview');
  await signedIn
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Month in review' })
    .click();

  // Opens on last month, the newest finished one, with nowhere later to go.
  await expect(signedIn.getByRole('button', { name: /Later|›/ })).toBeDisabled();
  await expect(signedIn.getByText('$4,000.00', { exact: true })).toBeVisible();
  // Went out is every line and the uncategorized row, together.
  await expect(signedIn.getByText('$94.11', { exact: true }).first()).toBeVisible();
  await expect(signedIn.getByText('Not categorized yet')).toBeVisible();

  await signedIn.getByRole('link', { name: '$84.12' }).click();
  await expect(signedIn).toHaveURL(/\/transactions\?/);
  await expect(signedIn.getByText(/^Matches Groceries in /)).toBeVisible();
  await expect(signedIn.getByText('1 row')).toBeVisible();
});
