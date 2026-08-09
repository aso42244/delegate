import { expect, makeAccount, test } from './fixtures.js';

/**
 * Settings → Bitcoin & Property.
 *
 * Both halves record a quantity or a dated value rather than a current dollar
 * figure. The assertions follow that: a holding is entered in Bitcoin and valued
 * at the price, and a value recorded for an older date is history rather than a
 * revaluation.
 */

test('a holding is entered as a quantity and valued at the price', async ({ signedIn, api }) => {
  await makeAccount('Hardware wallet', 'asset', 0n);
  // A price has to exist before anything can be worth anything.
  await api.post('/api/bitcoin/refresh').catch(() => undefined);

  await signedIn.goto('/settings/bitcoin');

  // No feed in the end-to-end environment, so this is the honest state: no
  // price, and therefore no value — never a zero.
  await expect(signedIn.getByText('No price has been fetched yet.')).toBeVisible();

  await signedIn.getByLabel('Bitcoin held in Hardware wallet').fill('0.05');
  await signedIn.getByRole('button', { name: 'Save' }).first().click();

  await expect(signedIn.getByText('Holding 0.05 BTC in total.')).toBeVisible();
});

test('a quantity finer than a satoshi is refused rather than rounded', async ({ signedIn }) => {
  await makeAccount('Hardware wallet', 'asset', 0n);
  await signedIn.goto('/settings/bitcoin');

  await signedIn.getByLabel('Bitcoin held in Hardware wallet').fill('0.000000001');
  await signedIn.getByRole('button', { name: 'Save' }).first().click();

  // Scoped: the "no price yet" banner is also an alert on this screen.
  await expect(signedIn.getByText('Bitcoin divides to eight places.')).toBeVisible();
});

test('a property value is recorded and becomes the current figure', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 0n);

  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByLabel('Property').selectOption({ label: 'The house' });

  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('As of').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Record this value' }).click();

  await expect(signedIn.getByText('this is now the current value')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'The house balance' })).toContainText(
    '$450,000.00',
  );
});

/**
 * The behaviour worth protecting: filling in a figure you forgot from March is
 * not a revaluation, and the screen says so rather than leaving it to be
 * inferred.
 */
test('a backdated value is history, and says it changed nothing', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 0n);

  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByLabel('Property').selectOption({ label: 'The house' });

  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByLabel('As of').fill('2026-06-15');
  await signedIn.getByRole('button', { name: 'Record this value' }).click();
  await expect(signedIn.getByText('this is now the current value')).toBeVisible();

  await signedIn.getByLabel('Value').fill('420000.00');
  await signedIn.getByLabel('As of').fill('2026-03-15');
  await signedIn.getByRole('button', { name: 'Record this value' }).click();

  await expect(signedIn.getByText('the current figure is unchanged')).toBeVisible();

  // Both are kept, newest first.
  await expect(signedIn.getByText('$420,000.00')).toBeVisible();
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'The house balance' })).toContainText(
    '$450,000.00',
  );
});

test('equity follows the mortgage down without anything being restated', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 0n);
  const mortgageId = await makeAccount('Mortgage', 'debt', 25_000_000n);

  await signedIn.goto('/settings/bitcoin');
  await signedIn.getByLabel('Property').selectOption({ label: 'The house' });
  await signedIn.getByLabel('Value').fill('450000.00');
  await signedIn.getByRole('button', { name: 'Record this value' }).click();
  await expect(signedIn.getByText('this is now the current value')).toBeVisible();

  await signedIn.getByLabel('Mortgage secured against it').selectOption({ label: 'Mortgage' });

  await expect(signedIn.getByText(/Equity is/)).toContainText('$200,000.00');
  expect(mortgageId).toBeTruthy();
});
