import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * The Main Budget, driven in a real browser.
 *
 * These cover what unit and integration tests structurally cannot: that the page
 * boots, that an edit reaches the server and comes back changed, and that the
 * headline figure agrees with the rows beneath it after every operation.
 */

test('signing in reaches the budget', async ({ signedIn }) => {
  await expect(signedIn.getByRole('heading', { name: 'Main Budget' })).toBeVisible();
  await expect(signedIn.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('an empty budget reads as balanced', async ({ signedIn }) => {
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
});

test('money that has landed reads as available to delegate, not as a fault', async ({
  signedIn,
}) => {
  await makeAccount('Everyday Checking', 'asset', 489000n);
  await signedIn.reload();

  // The ordinary payday state. It must not be styled as a warning.
  const banner = signedIn.getByRole('status');
  await expect(banner).toContainText('$4,890.00 to delegate');
  await expect(banner).not.toContainText('over-delegated');
});

test('a delegation is created by typing a name and pressing Enter', async ({ signedIn }) => {
  const field = signedIn.getByLabel('Add to Delegations');
  await field.fill('Grocery');
  await field.press('Enter');

  // Typing sixty of these by hand is the go-live path, so a name has to be enough.
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
});

test('editing a balance records the difference and updates the identity', async ({
  signedIn,
  api,
}) => {
  await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('650.00');
  await input.press('Enter');

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$650.00');
  // Assets 1000 − Delegations 650 = 350 still to delegate.
  await expect(signedIn.getByRole('status')).toContainText('$350.00 to delegate');
});

test('an unparseable amount is kept on screen rather than discarded', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('not a number');
  await input.press('Enter');

  // Silently dropping what someone typed is how a mistyped amount becomes an
  // unnoticed wrong number.
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('not a number');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('Escape abandons an edit', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('999.00');
  await input.press('Escape');

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('an ad-hoc line shows an em-dash rather than zero', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Occasional', null);
  await signedIn.reload();

  // Null means "adds nothing when Delegate is pressed", which reads differently
  // from a deliberate $0.
  await expect(signedIn.getByRole('button', { name: 'Occasional amount to delegate' })).toHaveText(
    '—',
  );
});

test('Delegate previews, distributes, and can be undone', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 30000n);
  await makeDelegation(api, 'Grocery', '20000');
  await makeDelegation(api, 'Power', '10000');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Delegate', exact: true }).click();

  const dialog = signedIn.getByRole('dialog', { name: 'Confirm delegate' });
  await expect(dialog).toContainText('$300.00');
  await expect(dialog).toContainText('2 lines');

  await dialog.getByRole('button', { name: 'Delegate', exact: true }).click();

  // Distributed: the identity lands on balanced.
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$200.00');

  // The undo offer states the cycle rollback, so it is not a surprise.
  await expect(signedIn.getByText('Undoing also rolls the budget cycle back.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Undo' }).click();

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
  await expect(signedIn.getByRole('status')).toContainText('$300.00 to delegate');
});

test('Transfer moves between envelopes without moving the bottom line', async ({
  signedIn,
  api,
}) => {
  await makeAccount('Everyday Checking', 'asset', 30000n);
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const balance = signedIn.getByLabel('Grocery balance');
  await balance.fill('300.00');
  await balance.press('Enter');
  await expect(signedIn.getByRole('status')).toContainText('Balanced');

  await signedIn.getByRole('button', { name: 'Transfer' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Transfer between delegations' });
  await dialog.getByLabel('From').selectOption({ label: 'Grocery' });
  await dialog.getByLabel('To').selectOption({ label: 'Dining' });
  await dialog.getByLabel('Amount').fill('100.00');
  await dialog.getByRole('button', { name: 'Transfer' }).click();

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$200.00');
  await expect(signedIn.getByRole('button', { name: 'Dining balance' })).toContainText('$100.00');
  // Envelope-to-envelope movement nets to zero across the delegations total.
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
});

test('a negative delegation balance is the only red in the table', async ({ signedIn, api }) => {
  await makeAccount('Card', 'debt', 54321n);
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('-25.00');
  await input.press('Enter');

  const negative = signedIn.getByRole('button', { name: 'Grocery balance' });
  await expect(negative).toHaveClass(/text-negative/);

  // Debts are liabilities but are never rendered red.
  await expect(signedIn.getByRole('button', { name: 'Card balance' })).not.toHaveClass(
    /text-negative/,
  );
});

test('the sidebar collapses and stays collapsed across a reload', async ({ signedIn }) => {
  await signedIn.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(signedIn.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

  await signedIn.reload();

  // Persisted per device, so it survives a refresh.
  await expect(signedIn.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});
