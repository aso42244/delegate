import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Entering a transaction by hand, and splitting one across envelopes.
 *
 * Two of the household's accounts are carried by no feed, so manual entry is how
 * their registers stay true. The assertions follow the money: the account
 * balance and the envelope both have to end up where the owner expects, because
 * a screen that saves something plausible but wrong is the failure that matters
 * here.
 */

test('a manual transaction moves the account balance', async ({ signedIn }) => {
  await makeAccount('Physical Cash', 'asset', 20000n);

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'New transaction' }).click();

  await signedIn.getByLabel('Account').selectOption({ label: 'Physical Cash' });
  await signedIn.getByLabel('Description').fill('Farmers market');
  await signedIn.getByLabel('Amount').fill('42.10');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  // The dialog closes only once the write and the refetch have both landed, so
  // this is the signal that it is safe to read a balance elsewhere.
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByText('Farmers market')).toBeVisible();

  // Money out by default: $200.00 − $42.10.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$157.90',
  );
});

test('money in raises the balance instead of lowering it', async ({ signedIn }) => {
  await makeAccount('Physical Cash', 'asset', 20000n);

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'New transaction' }).click();

  await signedIn.getByLabel('Account').selectOption({ label: 'Physical Cash' });
  await signedIn.getByLabel('Description').fill('Sold the old bicycle');
  await signedIn.getByLabel('Amount').fill('75');
  await signedIn.getByRole('radio', { name: 'Money in' }).click();
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$275.00',
  );
});

test('a delegation chosen while entering is applied to the new row', async ({ signedIn, api }) => {
  await makeAccount('Physical Cash', 'asset', 20000n);
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'New transaction' }).click();

  await signedIn.getByLabel('Account').selectOption({ label: 'Physical Cash' });
  await signedIn.getByLabel('Description').fill('Farmers market');
  await signedIn.getByLabel('Amount').fill('42.10');

  const picker = signedIn.getByLabel('Delegation for this transaction');
  await picker.fill('gro');
  await picker.press('Enter');

  await signedIn.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');
});

test('income allocates to nothing, so no delegation is offered', async ({ signedIn }) => {
  await makeAccount('Everyday Checking', 'asset', 500000n);

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'New transaction' }).click();
  await signedIn.getByLabel('Kind').selectOption({ label: 'Income' });

  await expect(signedIn.getByLabel('Delegation for this transaction')).toHaveCount(0);
});

test('a split must add up before it can be saved', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');
  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-10000',
      description: 'Big shop',
      postedAt: '2026-08-05T00:00:00Z',
    },
  });

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'Options for Big shop' }).click();
  await signedIn.getByRole('menuitem', { name: 'Split between delegations' }).click();

  const save = signedIn.getByRole('button', { name: 'Save split' });
  await expect(save).toBeDisabled();

  const first = signedIn.getByLabel('Delegation for split line 1');
  await first.fill('gro');
  await first.press('Enter');
  await signedIn.getByLabel('Amount for split line 1').fill('60.00');

  const second = signedIn.getByLabel('Delegation for split line 2');
  await second.fill('hou');
  await second.press('Enter');
  await signedIn.getByLabel('Amount for split line 2').fill('30.00');

  // $10 short, and it says so in words rather than only in colour.
  await expect(signedIn.getByText('$10.00 left to allocate.')).toBeVisible();
  await expect(save).toBeDisabled();

  await signedIn.getByLabel('Amount for split line 2').fill('40.00');
  await expect(signedIn.getByText('Balanced — the parts add up to the whole.')).toBeVisible();
  await save.click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$60.00');
  await expect(signedIn.getByRole('button', { name: 'Household balance' })).toContainText(
    '-$40.00',
  );
});

test('splitting evenly hands the odd cent to the first line', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');
  await makeDelegation(api, 'Fuel');
  await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-10000',
      description: 'Three ways',
      postedAt: '2026-08-05T00:00:00Z',
    },
  });

  await signedIn.goto('/transactions');
  await signedIn.getByRole('button', { name: 'Options for Three ways' }).click();
  await signedIn.getByRole('menuitem', { name: 'Split between delegations' }).click();

  const first = signedIn.getByLabel('Delegation for split line 1');
  await first.fill('gro');
  await first.press('Enter');
  const second = signedIn.getByLabel('Delegation for split line 2');
  await second.fill('hou');
  await second.press('Enter');

  await signedIn.getByRole('button', { name: 'Add line' }).click();
  const third = signedIn.getByLabel('Delegation for split line 3');
  await third.fill('fue');
  await third.press('Enter');

  await signedIn.getByRole('button', { name: 'Split evenly' }).click();

  // $100.00 across three: 33.34 / 33.33 / 33.33, summing exactly.
  await expect(signedIn.getByLabel('Amount for split line 1')).toHaveValue('33.34');
  await expect(signedIn.getByLabel('Amount for split line 3')).toHaveValue('33.33');
  await expect(signedIn.getByText('Balanced — the parts add up to the whole.')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Save split' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$33.34');
  await expect(signedIn.getByRole('button', { name: 'Fuel balance' })).toContainText('-$33.33');
});

/**
 * The same dialog, reached from the Budget page.
 *
 * Manual entry is how the two accounts no feed carries stay true, and the
 * Budget page is where the household notices one has drifted — so having to
 * leave it to fix that was a detour with no purpose.
 *
 * The assertion is that the page the button lives on updates itself. The Budget
 * page reads its balances once on load, so a dialog that saved without
 * invalidating the view would leave the number the owner is looking at stale
 * while everything else was right.
 *
 * Every field is reached through the dialog rather than through the page. The
 * Budget page has an "amount to delegate" control on every row, so a bare
 * `getByLabel('Amount')` matches those too — which is the same collision this
 * suite has been bitten by before.
 */
test('a transaction can be entered from the Budget page, which then updates', async ({
  signedIn,
  api,
}) => {
  await makeAccount('Physical Cash', 'asset', 20000n);
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$200.00',
  );

  await signedIn.getByRole('button', { name: 'New transaction' }).click();
  const dialog = signedIn.getByRole('dialog');

  await dialog.getByLabel('Account').selectOption({ label: 'Physical Cash' });
  await dialog.getByLabel('Description').fill('Farmers market');
  await dialog.getByLabel('Amount').fill('42.10');
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // No reload: the page the button is on has to refresh itself.
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$157.90',
  );
});

/**
 * An outstanding check is a delegation, and it is not somewhere spending can be
 * filed — it is settled by matching the payment that cashes it. The picker on
 * the Transactions page excludes them, and the one reached from the Budget page
 * has to as well, or the two routes to the same dialog disagree.
 */
test('the Budget page picker does not offer outstanding checks', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery', '40000');

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'New check' }).click();

  const checkDialog = signedIn.getByRole('dialog');
  await checkDialog.getByLabel('Check number').fill('1042');
  await checkDialog.getByLabel('Amount').fill('120.00');
  await checkDialog.getByLabel('Money comes from').selectOption({ label: 'Grocery' });
  await checkDialog.getByRole('button', { name: 'Record' }).click();

  // The check appearing on the page is the signal that the write landed.
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Check 1042 balance' })).toBeVisible();

  await signedIn.getByRole('button', { name: 'New transaction' }).click();
  const dialog = signedIn.getByRole('dialog');

  // Focusing the picker opens the list with everything it is willing to offer.
  await dialog.getByLabel('Delegation for this transaction').click();

  const options = signedIn.getByRole('listbox', { name: 'Delegations' });
  await expect(options).toBeVisible();
  await expect(options.getByRole('option', { name: 'Grocery' })).toBeVisible();
  await expect(options.getByRole('option', { name: /Check 1042/ })).toHaveCount(0);
});
