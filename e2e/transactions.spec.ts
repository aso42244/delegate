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

  // `exact`: the backlog pill is a link too, reading "2 new transactions", and an
  // accessible name is matched as a substring unless it is told not to be.
  await signedIn.getByRole('link', { name: 'Transactions', exact: true }).click();

  await expect(signedIn.getByRole('heading', { name: 'Transactions' })).toBeVisible();
  // Both of them: the one waiting and the one already dealt with.
  await expect(signedIn.getByText('Whole Foods Market')).toBeVisible();
  await expect(signedIn.getByText('Corner Shop')).toBeVisible();
  // The page no longer counts its own rows — that figure is on Settings → Sync
  // now, beside the connection that produced it. Both rows being on screen is
  // the assertion; the count was only ever a proxy for it.
  await expect(signedIn.getByRole('row')).toHaveCount(3);

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
  await signedIn.getByRole('link', { name: 'Transactions', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Uncategorized' }).click();

  // One row left in the queue, and it is the one that was never categorized.
  await expect(signedIn.getByText('Whole Foods Market')).toBeVisible();
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
test('the backlog pill clears as soon as the queue does', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const grocery = await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  const sorted = await makeTransaction(api, accountId, '-1500', 'Corner Shop');
  await api.post(`/api/transactions/${sorted}/categorize`, { data: { delegationId: grocery } });

  await signedIn.goto('/');
  const pill = signedIn.getByRole('link', { name: '1 new transaction' });
  await expect(pill).toBeVisible();

  /*
   * And it opens the queue rather than the register.
   *
   * The two ways of arriving want different things: the sidebar means "the
   * register" and this pill means "the ones I have not dealt with". The filter
   * is in the URL, which is what lets one link carry a default the other does
   * not.
   */
  await pill.click();
  await expect(signedIn).toHaveURL(/\/transactions\?uncategorized=true$/);
  // The queue, not the register: the categorized row is not on screen.
  await expect(signedIn.getByText('Corner Shop')).toHaveCount(0);

  const picker = signedIn.getByLabel('Categorize Whole Foods Market');
  await picker.fill('gro');
  await picker.press('Enter');
  // The row leaving the queue is the signal that the write landed.
  await expect(signedIn.getByText('Whole Foods Market')).toBeHidden();

  // Back to Budget the way a person goes back to it. Cached, before the fix in
  // main.tsx, this still said there was one waiting.
  await signedIn.getByRole('link', { name: 'Budget' }).click();
  await expect(signedIn.getByRole('link', { name: /new transaction/ })).toHaveCount(0);
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

/**
 * The queue teaching itself.
 *
 * Two charges from one shop have been filed by hand; the third arrives and the
 * row already knows where it goes. The store number differs on every visit, so
 * nothing here works unless the merchant is recognised through it.
 */
test('a merchant filed twice is suggested on the third', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const grocery = await makeDelegation(api, 'Grocery');

  for (const store of ['#123', '#4471']) {
    const filed = await makeTransaction(api, accountId, '-4210', `KROGER ${store} CINCINNATI`);
    await api.post(`/api/transactions/${filed}/categorize`, { data: { delegationId: grocery } });
  }
  await makeTransaction(api, accountId, '-3300', 'KROGER #9982 CINCINNATI');

  await signedIn.getByRole('link', { name: 'Transactions', exact: true }).click();

  // The evidence is in the accessible name, not only in a tooltip: a suggestion
  // nobody can weigh is an assertion.
  const suggestion = signedIn.getByRole('button', {
    name: /Categorize as Grocery — 2 of 2 before/,
  });
  await expect(suggestion).toBeVisible();

  await suggestion.click();

  // Assert the write landed before doing anything else: the row leaving the
  // queue is the signal, and navigating before it does makes this test lie.
  await expect(signedIn.getByRole('button', { name: /Categorize as Grocery/ })).toHaveCount(0);
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$117.20');
});

/**
 * And the way a repeated decision stops being one.
 *
 * A rule could only be written from Settings, against a merchant name somebody
 * had to remember and type — so the categorizations repeated most often were
 * exactly the ones nobody stopped to automate.
 */
test('a rule can be built from a row already filed', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const grocery = await makeDelegation(api, 'Grocery');
  const filed = await makeTransaction(api, accountId, '-4210', 'WHOLEFDS MKT #10234');
  await api.post(`/api/transactions/${filed}/categorize`, { data: { delegationId: grocery } });

  await signedIn.getByRole('link', { name: 'Transactions', exact: true }).click();
  await signedIn.getByRole('button', { name: 'Options for WHOLEFDS MKT #10234' }).click();
  await signedIn.getByRole('menuitem', { name: 'Always categorize like this' }).click();

  /*
   * The match text is offered as the merchant rather than the whole
   * description. `#10234` is this shop and this shop only: a rule matching all
   * of it would match the row it was built from and nothing else, for ever,
   * without ever saying so.
   */
  const dialog = signedIn.getByRole('dialog', { name: /Create a rule from/ });
  await expect(dialog.getByLabel('When the description contains')).toHaveValue('WHOLEFDS MKT');
  await dialog.getByRole('button', { name: 'Add' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await signedIn.goto('/settings/rules');
  await expect(signedIn.getByText('Description contains “WHOLEFDS MKT”')).toBeVisible();
});
