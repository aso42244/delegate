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
  await page.getByRole('button', { name: 'New check' }).click();

  // Scoped to the dialog: "Amount" also names a column on the page behind it.
  const dialog = page.getByRole('dialog', { name: 'New check' });
  await dialog.getByLabel('Check number').fill('1062');
  await dialog.getByLabel('Amount').fill('120.00');
  await dialog.getByLabel('Money comes from').selectOption({ label: 'Piano Lessons' });
  if (memo) await dialog.getByLabel('Memo').fill(memo);
  await dialog.getByRole('button', { name: 'Record' }).click();
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

test('a check is settled by hand when the bank never named it', async ({ signedIn: page, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Piano Lessons', '12000');

  await page.goto('/');
  await fundPianoLessons(page);

  await writeCheck(page);
  await expect(page.getByText('Check 1062')).toBeVisible();

  // The bank posts it. This is the path for a description that never names the
  // check number — the proposal below cannot be made, so the person picks.
  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-12000',
      description: 'CHECK 1062',
      postedAt: '2026-08-06T00:00:00Z',
    },
  });

  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Options for CHECK 1062' }).click();
  await page.getByRole('menuitem', { name: 'Match to an outstanding check' }).click();
  await page.getByRole('button', { name: 'Match', exact: true }).click();

  // The check is gone from the budget, and the spending landed on the envelope
  // rather than on a line called "Check 1062".
  await page.goto('/');
  await expect(page.getByText('Check 1062')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText('$0.00');
});

/**
 * The behaviour ADR 030 exists for.
 *
 * A sync used to settle a check on its own the moment the amount and the number
 * both agreed. It moved money between envelopes and archived a line while
 * nobody was watching. Now it proposes and waits.
 */
test('a check the bank has cashed waits to be confirmed', async ({ signedIn: page, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Piano Lessons', '12000');

  await page.goto('/');
  await fundPianoLessons(page);
  await writeCheck(page);
  await expect(page.getByText('Check 1062')).toBeVisible();

  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-12000',
      description: 'CHECK 1062',
      postedAt: '2026-08-06T00:00:00Z',
    },
  });

  await page.goto('/');

  // Proposed, and nothing more: the money is still on the check line. The
  // proposal is a pill beside the reading; what it says in full is its tooltip.
  const proposal = page.getByRole('link', { name: '1 check to confirm' });
  await expect(proposal).toBeVisible();
  // Which check, on hover. A hidden tooltip is out of the accessibility tree
  // entirely, so it has to be revealed before it can be asked about by role.
  await proposal.hover();
  await expect(page.getByRole('tooltip')).toContainText('Check 1062 looks like it has been cashed');
  await expect(page.getByRole('button', { name: 'Check 1062 balance' })).toContainText('$120.00');

  await page.getByRole('button', { name: 'Confirm it cleared' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm that check 1062 was cashed' });
  // Both sides shown, because the point of asking is that he can disagree.
  await expect(dialog).toContainText('CHECK 1062');
  await expect(dialog).toContainText('Piano Lessons');
  await dialog.getByRole('button', { name: 'Yes, it cleared' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Settled: the line is gone, the spending landed on the envelope rather than
  // on a line called "Check 1062", and the banner has nothing left to say.
  await expect(page.getByText('Check 1062')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Piano Lessons balance' })).toContainText('$0.00');
  await expect(page.getByRole('link', { name: '1 check to confirm' })).toHaveCount(0);

  /*
   * And the payment carries the `c` mark.
   *
   * The allocation points at Piano Lessons rather than at the check line, which
   * is right — money spent on piano lessons was spent on piano lessons — and
   * left nothing on the row saying a check was involved. The transaction
   * remembers the check it settled now, which is what the mark reads.
   */
  await page.goto('/transactions');
  await expect(page.getByTitle('Settled an outstanding check')).toBeVisible();
});

/**
 * The way to say no. There is no reject button, because a proposal is recomputed
 * from the data rather than remembered — it would simply come back.
 */
test('categorizing the payment as something else withdraws the proposal', async ({
  signedIn: page,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Piano Lessons', '12000');
  await makeDelegation(api, 'Grocery');

  await page.goto('/');
  await fundPianoLessons(page);
  await writeCheck(page);

  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-12000',
      description: 'CHECK 1062',
      postedAt: '2026-08-06T00:00:00Z',
    },
  });

  await page.goto('/');
  await expect(page.getByRole('link', { name: '1 check to confirm' })).toBeVisible();

  await page.goto('/transactions');
  const picker = page.getByLabel('Categorize CHECK 1062');
  await picker.fill('gro');
  await picker.press('Enter');

  // Wait for the write to land before navigating: the Budget page reads its
  // banners once on arrival, so getting there mid-write asserts on a stale one.
  // The picker shows what a row is categorized as in its placeholder, keeping
  // the field itself empty to type into.
  await expect(picker).toHaveAttribute('placeholder', 'Grocery');

  await page.goto('/');
  await expect(page.getByRole('link', { name: '1 check to confirm' })).toHaveCount(0);
  // And the check is untouched, still holding its money.
  await expect(page.getByRole('button', { name: 'Check 1062 balance' })).toContainText('$120.00');
});
