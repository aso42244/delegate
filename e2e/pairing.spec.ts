import { expect, makeAccount, makeDelegation, test } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Suggested transfers between owned accounts.
 *
 * §7: suggestions the owner confirms, never silent pairing — wrong automatic
 * pairing is worse than no pairing. So these check that nothing happens until
 * asked, and that a confirmed pair is reversible.
 */

async function makeTransaction(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
  postedAt: string,
): Promise<string> {
  const response = await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt },
  });
  const body = (await response.json()) as { transaction: { id: string } };
  return body.transaction.id;
}

test('suggests a matching pair and does nothing until confirmed', async ({ signedIn, api }) => {
  const checking = await makeAccount('Everyday Checking', 'asset', 500000n);
  const card = await makeAccount('Card', 'debt', 50000n);
  await makeTransaction(api, checking, '-50000', 'Payment to card', '2026-08-01T00:00:00Z');
  await makeTransaction(api, card, '50000', 'Payment received', '2026-08-03T00:00:00Z');

  await signedIn.goto('/transactions');

  await expect(signedIn.getByText('1 possible transfer between your accounts')).toBeVisible();
  await expect(signedIn.getByText('2 days apart')).toBeVisible();

  // Still ordinary transactions until told otherwise.
  await expect(signedIn.getByLabel('Categorize Payment to card')).toBeVisible();
});

test('confirming a pair takes both out of the spending queue', async ({ signedIn, api }) => {
  const checking = await makeAccount('Everyday Checking', 'asset', 500000n);
  const card = await makeAccount('Card', 'debt', 50000n);
  await makeTransaction(api, checking, '-50000', 'Payment to card', '2026-08-01T00:00:00Z');
  await makeTransaction(api, card, '50000', 'Payment received', '2026-08-03T00:00:00Z');

  await signedIn.goto('/transactions');
  await signedIn
    .getByRole('button', { name: 'Pair Payment to card with Payment received' })
    .click();

  await expect(signedIn.getByText('possible transfer')).toHaveCount(0);
  // Both are transfers now, so neither offers a delegation picker.
  await expect(signedIn.getByLabel('Categorize Payment to card')).toHaveCount(0);
});

test('a confirmed pair can be undone', async ({ signedIn, api }) => {
  const checking = await makeAccount('Everyday Checking', 'asset', 500000n);
  const card = await makeAccount('Card', 'debt', 50000n);
  await makeTransaction(api, checking, '-50000', 'Payment to card', '2026-08-01T00:00:00Z');
  await makeTransaction(api, card, '50000', 'Payment received', '2026-08-03T00:00:00Z');

  await signedIn.goto('/transactions');
  await signedIn
    .getByRole('button', { name: 'Pair Payment to card with Payment received' })
    .click();
  await expect(signedIn.getByText('possible transfer')).toHaveCount(0);

  // Turn the uncategorized filter off so the paired rows are visible.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();
  await signedIn.getByRole('button', { name: 'Unpair Payment to card' }).click();

  // Back to ordinary transactions, and suggested again.
  await expect(signedIn.getByText('1 possible transfer between your accounts')).toBeVisible();
});

/** Confirming reverses any categorization: a transfer allocates to nothing. */
test('pairing returns a delegation that had been moved', async ({ signedIn, api }) => {
  const checking = await makeAccount('Everyday Checking', 'asset', 500000n);
  const card = await makeAccount('Card', 'debt', 50000n);
  const grocery = await makeDelegation(api, 'Grocery');

  const out = await makeTransaction(
    api,
    checking,
    '-50000',
    'Payment to card',
    '2026-08-01T00:00:00Z',
  );
  await makeTransaction(api, card, '50000', 'Payment received', '2026-08-03T00:00:00Z');
  await api.post(`/api/transactions/${out}/categorize`, { data: { delegationId: grocery } });

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$500.00');

  await signedIn.goto('/transactions');
  await signedIn
    .getByRole('button', { name: 'Pair Payment to card with Payment received' })
    .click();
  await expect(signedIn.getByText('possible transfer')).toHaveCount(0);

  await signedIn.goto('/');
  // No money left the household, so the envelope is back where it started.
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('a suggestion can be dismissed without pairing anything', async ({ signedIn, api }) => {
  const checking = await makeAccount('Everyday Checking', 'asset', 500000n);
  const card = await makeAccount('Card', 'debt', 50000n);
  await makeTransaction(api, checking, '-50000', 'Payment to card', '2026-08-01T00:00:00Z');
  await makeTransaction(api, card, '50000', 'Payment received', '2026-08-03T00:00:00Z');

  await signedIn.goto('/transactions');
  await signedIn
    .getByRole('button', { name: 'Dismiss the suggestion for Payment to card' })
    .click();

  await expect(signedIn.getByText('possible transfer')).toHaveCount(0);
  // Dismissing is not pairing: both are still ordinary transactions.
  await expect(signedIn.getByLabel('Categorize Payment to card')).toBeVisible();
});
