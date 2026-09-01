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

/**
 * The register opens unfiltered.
 *
 * It used to open on the uncategorized queue, which is right for a session
 * spent clearing a backlog and wrong for every other visit — a register that
 * hides most of the register has to be un-configured before anything can be
 * looked up.
 */
test('shows every transaction by default, filtered by nothing', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const waiting = await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  const sorted = await makeTransaction(api, accountId, '-1500', 'Corner Shop');

  const grocery = await makeDelegation(api, 'Grocery');
  await api.post(`/api/transactions/${sorted}/categorize`, {
    data: { delegationId: grocery },
  });

  await signedIn.getByRole('link', { name: 'Transactions' }).click();

  await expect(signedIn.getByRole('heading', { name: 'Transactions' })).toBeVisible();
  // Both of them: the one waiting and the one already dealt with.
  await expect(signedIn.getByText('Whole Foods Market')).toBeVisible();
  await expect(signedIn.getByText('Corner Shop')).toBeVisible();
  // Exact: the notification banner carries very similar wording, and a
  // substring match would resolve to both as soon as its query landed.
  await expect(signedIn.getByText('2 transactions.')).toBeVisible();

  expect(waiting).not.toBe(sorted);
});

test('the uncategorized queue is one press away', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  const sorted = await makeTransaction(api, accountId, '-1500', 'Corner Shop');

  const grocery = await makeDelegation(api, 'Grocery');
  await api.post(`/api/transactions/${sorted}/categorize`, {
    data: { delegationId: grocery },
  });

  // Navigated through the interface, never `goto`. A full page load remounts the
  // application and refetches everything, which hides this bug completely — the
  // owner's route was clicking the sidebar, and that serves the cache.
  await signedIn.getByRole('link', { name: 'Transactions' }).click();
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();

  await expect(signedIn.getByText('1 transaction waiting to be categorized.')).toBeVisible();
  await expect(signedIn.getByText('Corner Shop')).toHaveCount(0);
});

/**
 * The banner is a reading of a fact, and the fact moved.
 *
 * It was invalidated at two call sites out of the dozens that can change it, and
 * categorizing was not one of them — so "1 transaction waiting to be
 * categorized" stayed on screen after the queue was empty, and going back to the
 * Budget page did not help because the answer was already cached. It cleared
 * five minutes later, on the poll, which is not an answer.
 */
test('the uncategorized banner clears as soon as the queue does', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/');
  // Scoped to the banner. The Transactions subtitle carries the same words, so
  // an unscoped match there reads the page's own copy back and proves nothing —
  // the collision docs/handoff.md records.
  const banner = signedIn.getByRole('status').filter({ hasText: 'waiting to be categorized' });
  await expect(banner).toBeVisible();

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();

  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');
  await picker.press('Enter');
  // The row leaving the queue is the signal that the write landed.
  await expect(signedIn.getByText('Whole Foods Market')).toBeHidden();

  // Back to Budget the way a person goes back to it.
  await signedIn.getByRole('link', { name: 'Budget' }).click();
  await expect(
    signedIn.getByRole('status').filter({ hasText: 'waiting to be categorized' }),
  ).toHaveCount(0);
});

test('categorizing with the keyboard removes the row from the queue', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/transactions');
  // The queue, explicitly: the page no longer opens filtered, and what is under
  // test here is a row leaving it.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();

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
  // The queue, explicitly: the page no longer opens filtered, and what is under
  // test here is a row leaving it.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();
  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');
  await picker.press('Enter');

  // Wait for the row to leave the queue before navigating. The Budget page reads
  // its balances once on load, so arriving mid-write would snapshot a number
  // that never updates and the assertion would poll a stale DOM for its whole
  // timeout.
  await expect(signedIn.getByText('Whole Foods Market')).toBeHidden();

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
  // The queue, explicitly: the page no longer opens filtered, and what is under
  // test here is a row leaving it.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();
  await signedIn.getByLabel('Select Shop one').check();
  await signedIn.getByLabel('Select Shop two').check();

  await expect(signedIn.getByText('2 selected — assign all to')).toBeVisible();

  const picker = signedIn.getByLabel('Bulk categorize selection');
  await picker.fill('gro');
  await picker.press('Enter');

  // Both rows must have left the queue before navigating: a bulk apply
  // categorizes one row at a time, so arriving early would read a balance with
  // only half the selection in it.
  await expect(signedIn.getByText('Shop one')).toBeHidden();
  await expect(signedIn.getByText('Shop two')).toBeHidden();

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

  // Nothing to switch off any more: the register opens unfiltered, and income
  // would never have appeared in the queue in the first place.
  await signedIn.goto('/transactions');

  await expect(signedIn.getByText('Paycheck')).toBeVisible();
  await expect(signedIn.getByLabel('Categorize Paycheck')).toHaveCount(0);
});

/**
 * Archiving a transaction, which is how a duplicate leaves the register.
 *
 * A re-linked institution can re-import rows that are already there, and until
 * now there was no way to take one out without a database prompt. Archive, never
 * Delete: nothing here is hard-deleted.
 */
test('a duplicate is archived, and the money it moved comes back', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const delegationId = await makeDelegation(api, 'Grocery');
  const duplicate = await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await api.post(`/api/transactions/${duplicate}/categorize`, {
    data: { delegationId },
  });

  // It moved an envelope, which archiving has to put back.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'Options for Whole Foods Market' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  // Gone from the register …
  await expect(signedIn.getByText('Whole Foods Market')).toHaveCount(0);

  // … and the envelope is whole again.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

/**
 * Income allocates to nothing by design, so a payday deposit stops asking to be
 * filed anywhere.
 */
test('a deposit marked as income leaves the queue and offers no envelope', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '260433', 'ACH Deposit PAYROLL');

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();
  await expect(signedIn.getByText('ACH Deposit PAYROLL')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Options for ACH Deposit PAYROLL' }).click();
  await signedIn.getByRole('menuitem', { name: 'Mark as income' }).click();

  // Out of the queue: income is not waiting for a decision.
  await expect(signedIn.getByText('ACH Deposit PAYROLL')).toHaveCount(0);

  // And still in the register, with no picker on it.
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();
  await expect(signedIn.getByText('ACH Deposit PAYROLL')).toBeVisible();
  await expect(signedIn.getByLabel('Categorize ACH Deposit PAYROLL')).toHaveCount(0);
});

/**
 * The chip vocabulary, on the register.
 *
 * Every mark is one letter, and every one carries its meaning for anyone who
 * cannot see it. These assert on the meanings rather than the letters: the
 * letter is what is painted, the meaning is what it is for.
 */
test('a register row is marked with letters that carry their meaning', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');

  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '489000',
      description: 'Paycheck',
      postedAt: '2026-08-05T00:00:00Z',
      kind: 'income',
    },
  });
  await makeTransaction(api, accountId, '-10000', 'Costco Run');

  await signedIn.goto('/transactions');

  // Income allocates to nothing, so it is what it is and nothing more.
  await expect(signedIn.getByTitle('Income — allocates to nothing')).toBeVisible();

  // A split earns its own mark: one row, two envelopes.
  await signedIn.getByRole('button', { name: 'Options for Costco Run' }).click();
  await signedIn.getByRole('menuitem', { name: 'Split between delegations' }).click();

  const first = signedIn.getByLabel('Delegation for split line 1');
  await first.fill('gro');
  await first.press('Enter');
  await signedIn.getByLabel('Amount for split line 1').fill('60.00');

  const second = signedIn.getByLabel('Delegation for split line 2');
  await second.fill('hou');
  await second.press('Enter');
  await signedIn.getByLabel('Amount for split line 2').fill('40.00');

  await signedIn.getByRole('button', { name: 'Save split' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(signedIn.getByTitle('Split across more than one delegation')).toBeVisible();
});
