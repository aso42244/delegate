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

/** Creates an account through the dialog, which is the only route now. */
async function createAccount(
  page: import('@playwright/test').Page,
  username: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Create account' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  await dialog.getByLabel('Username').fill(username);
  await dialog.getByLabel('Temporary password').fill('temporary-passphrase-here');
  await dialog.getByRole('button', { name: 'Create account' }).click();

  // The dialog closing is the signal the write landed and the list refetched.
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('the first account is Super Admin and can create another', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  await expect(signedIn.getByText('e2e-owner@example.test', { exact: true }).first()).toBeVisible();
  await expect(signedIn.getByText('Super Admin', { exact: true }).first()).toBeVisible();

  await createAccount(signedIn, 'second@example.test');

  await expect(signedIn.getByText('second@example.test', { exact: true })).toBeVisible();
  // A temporary password reaches exactly one screen until it is changed.
  await expect(signedIn.getByText('Temporary password', { exact: true })).toBeVisible();
  // And a second factor is required of it before even that.
  await expect(signedIn.getByText('Not set up yet').first()).toBeVisible();
});

/**
 * A display name, which anybody can set for themselves whatever role they hold.
 * The username is an email address and reads as one everywhere it appears.
 */
test('a display name replaces the username on screen', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  await signedIn.getByLabel('Display name').fill('Andy');
  await signedIn.getByRole('button', { name: 'Save' }).click();
  await expect(signedIn.getByText('Saved.')).toBeVisible();

  await signedIn.reload();
  await expect(signedIn.getByLabel('Display name')).toHaveValue('Andy');
  // Shown in the list, with the username kept underneath it.
  await expect(signedIn.getByText('Andy', { exact: true }).first()).toBeVisible();
});

test('an account can be archived and restored, but not your own', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');
  await createAccount(signedIn, 'second@example.test');
  await expect(signedIn.getByText('second@example.test', { exact: true })).toBeVisible();

  const rows = signedIn.locator('tbody tr');
  const owner = rows.filter({ hasText: 'e2e-owner@example.test' });
  const second = rows.filter({ hasText: 'second@example.test' });

  // Archiving yourself would lock the household out of its own budget.
  await expect(owner.getByRole('button', { name: 'Archive' })).toHaveCount(0);

  await second.getByRole('button', { name: 'Archive' }).click();
  await expect(second.getByRole('button', { name: 'Restore' })).toBeVisible();

  await second.getByRole('button', { name: 'Restore' }).click();
  await expect(second.getByRole('button', { name: 'Archive' })).toBeVisible();
});

/**
 * The way back when the phone is gone and the recovery codes went with it.
 * Sign-in demands the second factor whenever one is confirmed, and no setting
 * anywhere changes that — so without this the only route is a database prompt.
 */
test('an administrator can reset somebody else’s second factor', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  const owner = signedIn.locator('tbody tr').filter({ hasText: 'e2e-owner@example.test' });
  await expect(owner.getByText('Set up')).toBeVisible();

  await owner.getByRole('button', { name: 'Reset two-factor' }).click();

  /*
   * Either landing proves it, and which one you get is a race.
   *
   * The reset deletes that account's sessions. Your own may survive it, because
   * the very request that did the deleting writes its session back on the way
   * out — `rolling: true` refreshes the expiry on every response — and whether
   * that write lands before or after the delete commits is not ordered.
   *
   * So: signed out, or sent to enrolment. Both say the factor is gone, which is
   * the whole claim. Asserting on one of them is asserting on the race, and
   * this test failed exactly once that way under load before it said so.
   */
  await signedIn.reload();
  await expect(
    signedIn
      .getByRole('heading', { name: 'Set up two-factor authentication' })
      .or(signedIn.getByLabel('Username')),
  ).toBeVisible();
});
