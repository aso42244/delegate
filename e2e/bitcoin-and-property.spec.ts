import { expect, makeAccount, test } from './fixtures.js';

/**
 * Settings → Bitcoin, and Settings → Properties.
 *
 * Both are created where they are managed. That is the point of these: no
 * account is made under Accounts first, and the thing appears on the budget or
 * the net worth by itself. Both still store a quantity or a dated value rather
 * than a current dollar figure, and the assertions follow that.
 */

test('a holding is added on its own tab and becomes an asset', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByRole('button', { name: 'New holding' }).click();

  // No account beforehand — this used to need one created under Accounts.
  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByLabel('Quantity').fill('0.05');
  await signedIn.getByRole('button', { name: 'Add' }).click();

  // Padded to eight places, because that is where Bitcoin stops dividing.
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toHaveValue('0.05000000');

  /*
   * It is an account now — and it appears on Settings → Accounts nowhere at all.
   * ADR 021 listed holdings and properties there so the page could not become
   * "a lie about what the budget is made of", then kept the promise in a
   * one-line footer; the owner wanted both managed only where they live, so the
   * footer went too. ADR 031 records what that costs.
   */
  await signedIn.goto('/settings/accounts');
  await expect(signedIn.getByText('Hardware wallet')).toHaveCount(0);

  // It is an account all the same — net worth on, budget off, which is the
  // default because Bitcoin is not spendable. Its own tab is where it lives.
  await signedIn.goto('/settings/bitcoin');
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toBeVisible();
});

test('a quantity finer than a satoshi is refused rather than rounded', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');

  await signedIn.getByRole('button', { name: 'New holding' }).click();

  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByLabel('Quantity').fill('0.000000001');
  await signedIn.getByRole('button', { name: 'Add' }).click();

  await expect(signedIn.getByText('Bitcoin divides to eight places.')).toBeVisible();
});

/**
 * The warning exists because an in-budget holding changes what the banner means:
 * "Balanced" starts moving with the market. Said once, because a warning
 * repeated on every toggle is one nobody reads.
 */
test('putting Bitcoin in the budget warns once, and not again', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByRole('button', { name: 'New holding' }).click();

  // `click`, not `check`: the box deliberately does not move until the warning
  // has been read, which is the behaviour under test.
  await signedIn.getByLabel('Budget').click();
  await expect(signedIn.getByText('changes what the banner means')).toBeVisible();

  await signedIn.getByRole('button', { name: 'I understand' }).click();
  await expect(signedIn.getByText('changes what the banner means')).toBeHidden();
  await expect(signedIn.getByLabel('Budget')).toBeChecked();

  await signedIn.reload();
  await signedIn.getByRole('button', { name: 'New holding' }).click();
  await signedIn.getByLabel('Budget').click();
  await expect(signedIn.getByText('changes what the banner means')).toBeHidden();
});

test('a property is added on its own tab, with its opening value', async ({ signedIn }) => {
  await signedIn.goto('/settings/properties');

  await signedIn.getByRole('button', { name: 'New property' }).click();

  await signedIn.getByLabel('Name').fill('The house');
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('As of').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Add' }).click();

  await expect(signedIn.getByRole('heading', { name: 'The house' })).toBeVisible();
  await expect(signedIn.getByText('Worth $450,000.00 as of 2026-06-15.')).toBeVisible();

  // Net worth by default, budget off: a house is not spendable.
  await expect(signedIn.getByLabel('The house counts towards net worth')).toBeChecked();
  await expect(signedIn.getByLabel('The house counts towards the budget')).not.toBeChecked();
});

/**
 * The behaviour worth protecting: filling in a figure you forgot from March is
 * not a revaluation, and the screen says so rather than leaving it to be
 * inferred.
 */
test('a backdated value is history, and says it changed nothing', async ({ signedIn }) => {
  await signedIn.goto('/settings/properties');
  await signedIn.getByRole('button', { name: 'New property' }).click();
  await signedIn.getByLabel('Name').fill('The house');
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('As of').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('heading', { name: 'The house' })).toBeVisible();

  await signedIn.getByRole('button', { name: 'New value' }).click();
  const valuing = signedIn.getByRole('dialog', { name: 'New value for The house' });
  await valuing.getByLabel('Value').fill('420000.00');
  await valuing.getByLabel('As of').fill('2026-03-15');
  await signedIn.getByRole('button', { name: 'Record' }).click();

  await expect(signedIn.getByText('the current value is unchanged')).toBeVisible();
  await expect(signedIn.getByText('Worth $450,000.00 as of 2026-06-15.')).toBeVisible();
});

test('equity follows the mortgage down without anything being restated', async ({ signedIn }) => {
  await makeAccount('Mortgage', 'debt', 25_000_000n);

  await signedIn.goto('/settings/properties');
  await signedIn.getByRole('button', { name: 'New property' }).click();
  await signedIn.getByLabel('Name').fill('The house');
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('Mortgage against it').selectOption({ label: 'Mortgage' });
  await signedIn.getByRole('button', { name: 'Add' }).click();

  await expect(signedIn.getByText(/^Equity/)).toContainText('$200,000.00');
});

/**
 * The reason the ledger exists: a quantity used to be one number, so the net
 * worth chart applied today's quantity to every past date. Recording when
 * Bitcoin was actually bought is what fixes that, and recording what was paid
 * makes cost basis fall out rather than being kept by hand.
 */
test('a historic purchase is recorded with what it cost', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByRole('button', { name: 'New holding' }).click();
  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toBeVisible();

  // The history hangs off the holding rather than sitting beside it.
  await signedIn.getByRole('button', { name: 'Hardware wallet' }).click();

  await signedIn.getByLabel('What happened').selectOption({ label: 'Bought' });
  await signedIn.getByLabel('How much').fill('0.5');
  await signedIn.getByLabel('When').fill('2026-06-15');
  await signedIn.getByLabel('Price of one Bitcoin').fill('60000.00');
  await signedIn.getByRole('button', { name: 'Record' }).click();

  // Half of $60,000 is what it cost, and the row says so on its own. Scoped to
  // a cell: the kind picker carries the same words as an option.
  await expect(signedIn.getByRole('cell', { name: 'Bought', exact: true })).toBeVisible();
  await expect(signedIn.getByRole('cell', { name: '$30,000.00', exact: true })).toBeVisible();

  // And the quantity followed, because the cache is a sum of the ledger.
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toHaveValue('0.50000000');
});

test('moving Bitcoin between your own wallets asks for no price', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByRole('button', { name: 'New holding' }).click();
  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByRole('button', { name: 'Add' }).click();
  await signedIn.getByRole('button', { name: 'Hardware wallet' }).click();

  await signedIn
    .getByLabel('What happened')
    .selectOption({ label: 'Moved in from another wallet' });

  // A price here would invent a gain out of moving your own money, so the field
  // is not offered rather than being offered and refused.
  await expect(signedIn.getByLabel('Price of one Bitcoin')).toBeHidden();
});

test('a mistake is backed out rather than deleted', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByRole('button', { name: 'New holding' }).click();
  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByRole('button', { name: 'Add' }).click();
  await signedIn.getByRole('button', { name: 'Hardware wallet' }).click();

  await signedIn.getByLabel('How much').fill('0.5');
  await signedIn.getByLabel('When').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Record' }).click();
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toHaveValue('0.50000000');

  await signedIn.getByRole('button', { name: /Back out the bought/ }).click();

  // The quantity goes back, and the row stays on screen struck through: it is
  // part of the history of what the chart showed.
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toHaveValue('0.00000000');
  await expect(signedIn.getByRole('cell', { name: 'Bought', exact: true })).toBeVisible();
});
