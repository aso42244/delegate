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

  // No account beforehand — this used to need one created under Accounts.
  await signedIn.getByLabel('Name').fill('Hardware wallet');
  await signedIn.getByLabel('Quantity').fill('0.05');
  await signedIn.getByRole('button', { name: 'Add' }).click();

  // Padded to eight places, because that is where Bitcoin stops dividing.
  await expect(signedIn.getByLabel('Hardware wallet quantity')).toHaveValue('0.05000000');

  // It is an account now, listed but not editable where it is not understood.
  await signedIn.goto('/settings/accounts');
  await expect(signedIn.getByRole('link', { name: 'Manage in Bitcoin' })).toBeVisible();
});

test('a quantity finer than a satoshi is refused rather than rounded', async ({ signedIn }) => {
  await signedIn.goto('/settings/bitcoin');

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

  // `click`, not `check`: the box deliberately does not move until the warning
  // has been read, which is the behaviour under test.
  await signedIn.getByLabel('Budget').click();
  await expect(signedIn.getByText('changes what the banner means')).toBeVisible();

  await signedIn.getByRole('button', { name: 'I understand' }).click();
  await expect(signedIn.getByText('changes what the banner means')).toBeHidden();
  await expect(signedIn.getByLabel('Budget')).toBeChecked();

  await signedIn.reload();
  await signedIn.getByLabel('Budget').click();
  await expect(signedIn.getByText('changes what the banner means')).toBeHidden();
});

test('a property is added on its own tab, with its opening value', async ({ signedIn }) => {
  await signedIn.goto('/settings/properties');

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
  await signedIn.getByLabel('Name').fill('The house');
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('As of').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('heading', { name: 'The house' })).toBeVisible();

  await signedIn.getByLabel('New value').fill('420000.00');
  await signedIn.getByLabel('As of').first().fill('2026-03-15');
  await signedIn.getByRole('button', { name: 'Record' }).click();

  await expect(signedIn.getByText('the current figure is unchanged')).toBeVisible();
  await expect(signedIn.getByText('Worth $450,000.00 as of 2026-06-15.')).toBeVisible();
});

test('equity follows the mortgage down without anything being restated', async ({ signedIn }) => {
  await makeAccount('Mortgage', 'debt', 25_000_000n);

  await signedIn.goto('/settings/properties');
  await signedIn.getByLabel('Name').fill('The house');
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('Mortgage against it').selectOption({ label: 'Mortgage' });
  await signedIn.getByRole('button', { name: 'Add' }).click();

  await expect(signedIn.getByText(/Equity is/)).toContainText('$200,000.00');
});
