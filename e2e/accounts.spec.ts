import { expect, makeAccount, test } from './fixtures.js';

/**
 * Settings → Accounts, and the asset and debt row menu on the Main Budget.
 *
 * The two booleans carry the weight here. `in_budget` decides whether an account
 * is part of the identity at all, and `in_net_worth` decides whether it shows on
 * the net worth chart — independently, which is the only reason a mortgage does
 * not swamp the budget.
 */

test('a manual account is added and appears on the Main Budget', async ({ signedIn }) => {
  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: '+ Add a manual account' }).click();

  await signedIn.getByLabel('Name').fill('Physical Cash');
  await signedIn.getByLabel('Balance', { exact: true }).fill('200.00');
  await signedIn.getByRole('button', { name: 'Add account' }).click();

  // Exact: the type control's label also contains the account name.
  await expect(signedIn.getByText('Physical Cash', { exact: true })).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$200.00',
  );
});

test('taking an account out of the budget removes it from the identity', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 45_000_000n);

  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('$450,000.00 to delegate');

  await signedIn.goto('/settings/accounts');
  const inBudget = signedIn.getByRole('switch', { name: 'The house in budget' });
  await inBudget.click();
  await expect(inBudget).toHaveAttribute('aria-checked', 'false');

  // Out of the budget, still in net worth: the separation that keeps a house
  // and its mortgage from drowning the envelope maths.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
  await expect(signedIn.getByRole('button', { name: 'The house balance' })).toHaveCount(0);

  await signedIn.goto('/settings/accounts');
  await expect(signedIn.getByRole('switch', { name: 'The house in net worth' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('a manual balance is editable from Settings and restamps the account', async ({
  signedIn,
}) => {
  await makeAccount('Physical Cash', 'asset', 20000n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Balance for Physical Cash' }).click();
  await signedIn.getByLabel('Balance for Physical Cash').fill('175.50');
  await signedIn.getByLabel('Balance for Physical Cash').press('Enter');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$175.50',
  );
});

test('archiving an in-budget account holding money is refused, with a way out', async ({
  signedIn,
}) => {
  await makeAccount('Everyday Checking', 'asset', 40000n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Archive Everyday Checking' }).click();

  // The identity subtracts what the accounts hold, so this would move the
  // bottom line by $400 with nothing on screen to explain it.
  await expect(signedIn.getByRole('alert')).toContainText('$400.00');
  // Still there: refused, not archived.
  await expect(signedIn.getByRole('button', { name: 'Archive Everyday Checking' })).toBeVisible();
});

test('an off-budget account archives at any balance', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 45_000_000n);

  await signedIn.goto('/settings/accounts');

  // Wait for the toggle to actually reflect the saved state before archiving.
  // Clicking straight through would race the PATCH, and the archive would be
  // refused for the right reason at the wrong moment.
  const inBudget = signedIn.getByRole('switch', { name: 'The house in budget' });
  await inBudget.click();
  await expect(inBudget).toHaveAttribute('aria-checked', 'false');

  await signedIn.getByRole('button', { name: 'Archive The house' }).click();

  // Not part of the identity, so there is nothing to protect.
  await expect(signedIn.getByRole('button', { name: 'Archive The house' })).toHaveCount(0);
});

test('the row menu on an asset offers the same settings as the Settings page', async ({
  signedIn,
}) => {
  await makeAccount('Physical Cash', 'asset', 20000n);
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Physical Cash' }).click();
  await expect(signedIn.getByRole('menu', { name: 'Options for Physical Cash' })).toBeVisible();

  await expect(signedIn.getByRole('switch', { name: 'Physical Cash in budget' })).toBeVisible();
  await expect(signedIn.getByRole('switch', { name: 'Physical Cash in net worth' })).toBeVisible();
  await expect(signedIn.getByRole('menuitem', { name: 'Set balance' })).toBeVisible();
  // Archive, never Delete — nothing in this system is hard-deleted.
  await expect(signedIn.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
});

test('the row menu sets a manual balance', async ({ signedIn }) => {
  await makeAccount('Physical Cash', 'asset', 20000n);
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Physical Cash' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set balance' }).click();
  await signedIn.getByLabel('Balance', { exact: true }).fill('175.50');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$175.50',
  );
});

/**
 * The next sync would overwrite anything typed, so the option is not offered at
 * all rather than offered and then quietly undone.
 */
test('a SimpleFIN account is not offered a balance to set', async ({ signedIn }) => {
  await makeAccount('Everyday Checking', 'asset', 500000n, 'simplefin');

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Everyday Checking' }).click();

  await expect(signedIn.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(signedIn.getByRole('menuitem', { name: 'Set balance' })).toHaveCount(0);

  // Nor from Settings: the cell is there but is not an editable control.
  await signedIn.goto('/settings/accounts');
  await expect(
    signedIn.getByRole('button', { name: 'Balance for Everyday Checking' }),
  ).toBeDisabled();
});

/**
 * §6.1: a sync guesses the type from the institution and account name, and the
 * owner can override it. A wrong guess moves the identity by twice the balance —
 * a credit card read as an asset adds what it should subtract.
 */
test('an account type can be corrected from Settings', async ({ signedIn }) => {
  await makeAccount('Mystery Account', 'asset', 40000n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByLabel('Type of Mystery Account').selectOption('debt');

  await signedIn.reload();
  await expect(signedIn.getByLabel('Type of Mystery Account')).toHaveValue('debt');

  // It moves from Assets to Debts on the budget, and the identity follows.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('$400.00 over-delegated');
});

test('an account type can be corrected from the row menu', async ({ signedIn }) => {
  await makeAccount('Mystery Account', 'asset', 40000n);

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Mystery Account' }).click();
  await signedIn.getByLabel('Type of Mystery Account').selectOption('debt');

  await expect(signedIn.getByRole('status')).toContainText('$400.00 over-delegated');
});
