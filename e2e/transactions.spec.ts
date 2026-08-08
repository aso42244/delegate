import { expect, makeAccount, makeDelegation, test } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * The Transactions page.
 *
 * Its job at go-live is a queue worked several hundred times in a sitting, so
 * these cover the loop rather than the chrome: filter to uncategorized, assign
 * with the keyboard, watch the row leave the queue.
 */

async function makeTransaction(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
): Promise<string> {
  const response = await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt: '2026-08-05T00:00:00Z' },
  });
  const body = (await response.json()) as { transaction: { id: string } };
  return body.transaction.id;
}

test('shows the uncategorized queue by default', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.getByRole('link', { name: 'Transactions' }).click();

  await expect(signedIn.getByRole('heading', { name: 'Transactions' })).toBeVisible();
  await expect(signedIn.getByText('Whole Foods Market')).toBeVisible();
  await expect(signedIn.getByText('waiting to be categorized')).toBeVisible();
});

test('categorizing with the keyboard removes the row from the queue', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/transactions');

  // Type a few letters, press Enter. No mouse, no scrolling sixty options.
  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');
  await picker.press('Enter');

  // The queue is filtered to uncategorized, so a categorized row leaves it.
  await expect(signedIn.getByText('Whole Foods Market')).toBeHidden();
});

test('a categorized transaction moves its delegation', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/transactions');
  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');
  await picker.press('Enter');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');
});

test('the type-ahead puts a prefix match first', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Home & Grounds');
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/transactions');
  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');

  // Both contain "gro"; the one that starts with it should be the default.
  const options = signedIn.getByRole('option');
  await expect(options.first()).toHaveText('Grocery');
});

test('search finds a transaction by amount', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  await makeTransaction(api, accountId, '-875', 'Coffee');

  await signedIn.goto('/transactions');
  await signedIn.getByLabel('Search transactions').fill('42.10');

  // The owner types what is on the screen; the sign is an implementation detail.
  await expect(signedIn.getByText('Whole Foods Market')).toBeVisible();
  await expect(signedIn.getByText('Coffee')).toBeHidden();
});

test('bulk categorize assigns a whole selection at once', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-1000', 'Shop one');
  await makeTransaction(api, accountId, '-2000', 'Shop two');

  await signedIn.goto('/transactions');
  await signedIn.getByLabel('Select Shop one').check();
  await signedIn.getByLabel('Select Shop two').check();

  await expect(signedIn.getByText('2 selected — assign all to')).toBeVisible();

  const picker = signedIn.getByLabel('Bulk categorize selection');
  await picker.fill('gro');
  await picker.press('Enter');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$30.00');
});

test('income offers no delegation picker, because it allocates to nothing', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '489000',
      description: 'Paycheck',
      postedAt: '2026-08-05T00:00:00Z',
      kind: 'income',
    },
  });

  await signedIn.goto('/transactions');
  // Filter off, since income is never "uncategorized" in the queue sense.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();

  await expect(signedIn.getByText('Paycheck')).toBeVisible();
  await expect(signedIn.getByLabel('Categorize Paycheck')).toHaveCount(0);
});
