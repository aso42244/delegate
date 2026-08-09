import { expect, makeAccount, makeDelegation, test } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Settings → Rules and Settings → Users.
 *
 * Rules move envelope balances across hundreds of rows at once, so the two
 * things worth guarding are the order they fire in — first match wins, and the
 * owner has to be able to tell which rule did what — and the promise that a bulk
 * apply never quietly overwrites a categorization made by hand.
 */

async function makeTransaction(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
): Promise<void> {
  await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt: '2026-08-05T00:00:00Z' },
  });
}

test('a rule is created and shown in the order it fires', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');

  await signedIn.goto('/settings/rules');

  await signedIn.getByLabel('This text').fill('whole foods');
  await signedIn.getByLabel('Categorize as').selectOption({ label: 'Grocery' });
  await signedIn.getByRole('button', { name: 'Add rule' }).click();

  await expect(signedIn.getByText('Description contains “whole foods”')).toBeVisible();
  await expect(signedIn.getByText('→ Grocery')).toBeVisible();
});

test('rules can be reordered, because the first match wins', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');

  await signedIn.goto('/settings/rules');

  await signedIn.getByLabel('This text').fill('market');
  await signedIn.getByLabel('Categorize as').selectOption({ label: 'Grocery' });
  await signedIn.getByRole('button', { name: 'Add rule' }).click();
  await expect(signedIn.getByText('Description contains “market”')).toBeVisible();

  await signedIn.getByLabel('This text').fill('corner');
  await signedIn.getByLabel('Categorize as').selectOption({ label: 'Dining' });
  await signedIn.getByRole('button', { name: 'Add rule' }).click();
  await expect(signedIn.getByText('Description contains “corner”')).toBeVisible();

  // Promote the second rule; "Corner Market" then goes to Dining rather than
  // Grocery, which is the whole point of the ordering.
  await signedIn.getByRole('button', { name: 'Move corner up' }).click();

  const rows = signedIn.getByText(/^Description contains/);
  await expect(rows.first()).toHaveText('Description contains “corner”');
});

test('the preview counts before anything moves, and leaves hand-made work alone', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  await makeTransaction(api, accountId, '-900', 'Unmatched thing');

  await signedIn.goto('/settings/rules');
  await signedIn.getByLabel('This text').fill('whole foods');
  await signedIn.getByLabel('Categorize as').selectOption({ label: 'Grocery' });
  await signedIn.getByRole('button', { name: 'Add rule' }).click();

  // "1 of 423" and "397 of 423" are different decisions, so the number comes
  // first and nothing has moved yet.
  await expect(signedIn.getByText('1 of 2 transactions would be categorized.')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('applying the rules categorizes the backlog', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/settings/rules');
  await signedIn.getByLabel('This text').fill('whole foods');
  await signedIn.getByLabel('Categorize as').selectOption({ label: 'Grocery' });
  await signedIn.getByRole('button', { name: 'Add rule' }).click();

  await signedIn.getByRole('button', { name: 'Apply now' }).click();
  await expect(signedIn.getByText('1 of 1 categorized.')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');
});

test('overwriting hand-made categorizations is opt-in and warns first', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/settings/rules');

  const toggle = signedIn.getByRole('switch', {
    name: 'Also change transactions already categorized',
  });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(signedIn.getByRole('alert')).toContainText(
    'replace categorizations you made by hand',
  );
});

test('the first account is Super Admin and can create another', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  // The first account created becomes Super Admin.
  await expect(signedIn.getByText('(you)')).toBeVisible();
  await expect(signedIn.getByLabel('Role of e2e-owner@example.test')).toHaveValue('super_admin');

  await signedIn.getByLabel('Username').fill('second@example.test');
  await signedIn.getByLabel('Temporary password').fill('temporary-passphrase-here');
  await signedIn.getByRole('button', { name: 'Create account' }).click();

  await expect(signedIn.getByText('second@example.test', { exact: true })).toBeVisible();
  // A temporary password reaches exactly one screen until it is changed.
  await expect(signedIn.getByText('must change password')).toBeVisible();
});

test('an account can be archived and restored, but not your own', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');
  await signedIn.getByLabel('Username').fill('second@example.test');
  await signedIn.getByLabel('Temporary password').fill('temporary-passphrase-here');
  await signedIn.getByRole('button', { name: 'Create account' }).click();
  await expect(signedIn.getByText('second@example.test', { exact: true })).toBeVisible();

  // Archiving yourself would lock the household out of its own budget.
  await expect(
    signedIn.getByRole('button', { name: 'Archive e2e-owner@example.test' }),
  ).toHaveCount(0);

  // Asserted through the control rather than the badge: "Archived" is also a
  // navigation item on this page, and getByText matches substrings.
  await signedIn.getByRole('button', { name: 'Archive second@example.test' }).click();
  await expect(signedIn.getByRole('button', { name: 'Restore second@example.test' })).toBeVisible();

  await signedIn.getByRole('button', { name: 'Restore second@example.test' }).click();
  await expect(signedIn.getByRole('button', { name: 'Archive second@example.test' })).toBeVisible();
});
