import { expect, makeAccount, test } from './fixtures.js';

/**
 * Settings → Accounts, and the asset and debt row menu on the Budget page.
 *
 * The two booleans carry the weight here. `in_budget` decides whether an account
 * is part of the identity at all, and `in_net_worth` decides whether it shows on
 * the net worth chart — independently, which is the only reason a mortgage does
 * not swamp the budget.
 *
 * Settings is one line per account in two tables, Assets and Debts. Both
 * switches stay on the row; the type, the nickname and Archive are reached
 * through the same `⋯` menu the Budget page uses, which is why several of these
 * open it first.
 */

test('a manual account is added and appears on the Budget page', async ({ signedIn }) => {
  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'New account' }).click();

  const dialog = signedIn.getByRole('dialog', { name: 'Add an account you keep by hand' });
  await dialog.getByLabel('Name').fill('Physical Cash');
  await dialog.getByLabel('Balance', { exact: true }).fill('200.00');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // The row shows the name, and a manual account carries the `m` mark. Located
  // by its meaning rather than its letter: the letter is what is painted, the
  // meaning is what it is for, and it is the half that must not drift.
  await expect(signedIn.getByText('Physical Cash', { exact: true })).toBeVisible();
  await expect(signedIn.getByTitle('Kept by hand')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Physical Cash balance' })).toContainText(
    '$200.00',
  );
});

test('taking an account out of the budget removes it from the identity', async ({ signedIn }) => {
  await makeAccount('The house', 'asset', 45_000_000n);

  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('To delegate $450,000.00');

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
  await signedIn.getByRole('button', { name: 'Options for Everyday Checking' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  // The identity subtracts what the accounts hold, so this would move the
  // bottom line by $400 with nothing on screen to explain it.
  await expect(signedIn.getByRole('alert')).toContainText('$400.00');
  // The refusal offers the honest way out rather than only saying no.
  await expect(signedIn.getByRole('button', { name: 'Take it out of the budget' })).toBeVisible();
  // Still there: refused, not archived.
  await expect(
    signedIn.getByRole('button', { name: 'Options for Everyday Checking' }),
  ).toBeVisible();
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

  await signedIn.getByRole('button', { name: 'Options for The house' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  // Not part of the identity, so there is nothing to protect.
  await expect(signedIn.getByRole('button', { name: 'Options for The house' })).toHaveCount(0);
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

  /*
   * Neither a balance nor a name. A SimpleFIN account is called whatever the
   * institution calls it: the next sync would not restore a name typed over it,
   * it would simply leave the two disagreeing with nothing on the page saying
   * they ever matched. Nickname is the supported way to call it something else.
   */
  await expect(signedIn.getByRole('menuitem', { name: 'Set balance' })).toHaveCount(0);
  await expect(signedIn.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);

  // Nor from Settings: the cell is there but is not an editable control. The
  // nickname is offered there and only there — the budget row already shows the
  // nickname in place of the name, so it has no pair to edit.
  await signedIn.goto('/settings/accounts');
  await expect(
    signedIn.getByRole('button', { name: 'Balance for Everyday Checking' }),
  ).toBeDisabled();

  await signedIn.getByRole('button', { name: 'Options for Everyday Checking' }).click();
  await expect(signedIn.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
  await expect(signedIn.getByRole('menuitem', { name: 'Nickname' })).toBeVisible();
});

/**
 * §6.1: a sync guesses the type from the institution and account name, and the
 * owner can override it. A wrong guess moves the identity by twice the balance —
 * a credit card read as an asset adds what it should subtract.
 */
test('an account type can be corrected from Settings', async ({ signedIn }) => {
  await makeAccount('Mystery Account', 'asset', 40000n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Options for Mystery Account' }).click();
  await signedIn.getByLabel('Type of Mystery Account').selectOption('debt');

  /*
   * The section a row sits in *is* its type, so correcting it moves the row to
   * the other table. Asserting that rather than reloading also waits for the
   * write: the row only lands here once the refetch that follows it has.
   */
  const debts = signedIn
    .locator('table')
    .filter({ has: signedIn.getByRole('columnheader', { name: 'Debts' }) });
  await expect(debts.getByText('Mystery Account', { exact: true })).toBeVisible();

  // And on the budget, where the identity follows it.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('Over delegated $400.00');
});

test('an account type can be corrected from the row menu', async ({ signedIn }) => {
  await makeAccount('Mystery Account', 'asset', 40000n);

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Mystery Account' }).click();
  await signedIn.getByLabel('Type of Mystery Account').selectOption('debt');

  await expect(signedIn.getByRole('status')).toContainText('Over delegated $400.00');
});

/**
 * The other half of the same rule: this budget owns a manual account's name, so
 * renaming it is not a thing the next sync will quietly disagree with.
 */
test('a manual account can be renamed', async ({ signedIn }) => {
  await makeAccount('Physical Cash', 'asset', 20000n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Options for Physical Cash' }).click();
  await signedIn.getByRole('menuitem', { name: 'Rename' }).click();

  const dialog = signedIn.getByRole('dialog', { name: 'Rename Physical Cash' });
  await dialog.getByLabel('Name').fill('Petty Cash');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(signedIn.getByText('Petty Cash', { exact: true })).toBeVisible();
});

/**
 * How old the feed's own answer is.
 *
 * The case behind this: ten charges stayed marked pending for days after the
 * card had posted them, and the application had nothing to say about it because
 * the stored balance, the stuck rows and the card's real balance were all behind
 * *together* and therefore consistent. The bridge reported itself healthy
 * throughout. See ADR 032.
 */
test('a synced balance the feed has not refreshed is marked, and says from when', async ({
  signedIn,
}) => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await makeAccount('Stale Card', 'debt', 560_983n, 'simplefin', threeDaysAgo);

  await signedIn.goto('/settings/accounts');

  // Located by meaning rather than by letter, like every other chip assertion
  // here: the letter is what is painted, the meaning is what must not drift.
  await expect(signedIn.getByTitle('Balance may not be current')).toBeVisible();

  // The date beside it, because the mark alone sends somebody looking for a
  // fault inside this application rather than at the bridge.
  await expect(
    signedIn.getByText(`feed from ${threeDaysAgo.toLocaleDateString('en-US')}`),
  ).toBeVisible();
});

test('a synced balance the feed refreshed today is not marked', async ({ signedIn }) => {
  await makeAccount('Fresh Card', 'debt', 560_983n, 'simplefin', new Date());

  await signedIn.goto('/settings/accounts');

  await expect(signedIn.getByText('Fresh Card', { exact: true })).toBeVisible();
  await expect(signedIn.getByTitle('Balance may not be current')).toHaveCount(0);
});

/**
 * Silence is not evidence. A feed that sends no `balance-date` says nothing
 * about the age of its answer, and warning on that would be the same mistake as
 * assuming freshness, pointed the other way.
 */
test('a feed that sends no date is left unmarked rather than warned about', async ({
  signedIn,
}) => {
  await makeAccount('Quiet Card', 'debt', 560_983n, 'simplefin', null);

  await signedIn.goto('/settings/accounts');

  await expect(signedIn.getByText('Quiet Card', { exact: true })).toBeVisible();
  await expect(signedIn.getByTitle('Balance may not be current')).toHaveCount(0);
});
