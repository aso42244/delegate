import type { Page } from '@playwright/test';
import { expect, test, makeAccount, makeDelegation } from './fixtures.js';

/**
 * Outstanding checks, through the screens.
 *
 * The point of the feature is the gap between writing a check and it clearing:
 * during that gap the envelope must stop showing money that is already spent.
 * So the assertions follow the money rather than the widgets.
 */

/** Presses Delegate, which is what puts $120 into Piano Lessons. */
async function fundPianoLessons(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Delegate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm delegate' });
  await dialog.getByRole('button', { name: 'Delegate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText(
    '$120.00',
  );
}

/** Records check 1062 for $120 against Piano Lessons. */
async function writeCheck(page: Page, memo?: string): Promise<void> {
  await page.getByRole('button', { name: 'New outstanding check' }).click();

  // Scoped to the dialog: "Amount" also names a column on the page behind it.
  const dialog = page.getByRole('dialog', { name: 'New outstanding check' });
  await dialog.getByLabel('Check number').fill('1062');
  await dialog.getByLabel('Amount').fill('120.00');
  await dialog.getByLabel('Money comes from').selectOption({ label: 'Piano Lessons' });
  if (memo) await dialog.getByLabel('Memo').fill(memo);
  await dialog.getByRole('button', { name: 'Record check' }).click();
}

test('a check moves money out of its envelope and onto its own line', async ({
  signedIn: page,
  api,
}) => {
  // An account holding exactly what the envelope will claim, so the identity
  // starts level and any drift caused by the check is visible immediately.
  await makeAccount('Everyday Checking', 'asset', 12000n);
  await makeDelegation(api, 'Piano Lessons', '12000');
  await page.goto('/');

  // Fund the envelope so there is something to write a check against.
  await fundPianoLessons(page);

  await writeCheck(page, 'August lessons');

  // The envelope is empty, and the money is visibly held somewhere.
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText('$0.00');
  await expect(page.getByText('Outstanding Checks')).toBeVisible();
  await expect(page.getByText('Check 1062 — August lessons')).toBeVisible();

  // And the budget still balances: nothing has left the household yet.
  await expect(page.getByRole('status')).toContainText('Balanced');
});

test('a check is voided back to where the money came from', async ({ signedIn: page, api }) => {
  await makeAccount('Everyday Checking', 'asset', 12000n);
  await makeDelegation(api, 'Piano Lessons', '12000');
  await page.goto('/');
  await fundPianoLessons(page);

  await writeCheck(page);
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText('$0.00');

  await page.getByRole('button', { name: 'Options for Check 1062' }).click();
  await page.getByRole('menuitem', { name: 'Void check' }).click();
  await page.getByRole('button', { name: 'Void check' }).click();

  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText(
    '$120.00',
  );
  await expect(page.getByText('Check 1062')).toBeHidden();
});

test('a payment naming the check settles it on the next sync', async ({ signedIn: page, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Piano Lessons', '12000');

  await page.goto('/');
  await fundPianoLessons(page);

  await writeCheck(page);
  await expect(page.getByText('Check 1062')).toBeVisible();

  // The bank posts it. Matching by hand is the same path the automatic match
  // takes, and is the one a person can drive.
  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-12000',
      description: 'CHECK 1062',
      postedAt: '2026-08-06T00:00:00Z',
    },
  });

  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Match CHECK 1062 to a check' }).click();
  await page.getByRole('button', { name: 'Match', exact: true }).click();

  // The check is gone from the budget, and the spending landed on the envelope
  // rather than on a line called "Check 1062".
  await page.goto('/');
  await expect(page.getByText('Check 1062')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText('$0.00');
});
