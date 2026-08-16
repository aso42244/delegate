import { expect, makeDelegation, test } from './fixtures.js';

/**
 * The per-row menu on the Budget page.
 *
 * The two behaviours worth protecting are the ones that are easy to get wrong
 * and expensive when they are: a manual adjustment must record a **movement**
 * rather than a new total, and archiving must be refused while the line still
 * holds money — archiving money would break the budget identity by that amount
 * with nothing on screen to explain it.
 */

test('the menu is reachable and names the line', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await expect(signedIn.getByRole('menu', { name: 'Options for Grocery' })).toBeVisible();
  await expect(signedIn.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  // Never Delete: nothing in this system is hard-deleted.
  await expect(signedIn.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
});

/**
 * The trigger is revealed on hover, so it has to be operable without one — a
 * control that exists only under a mouse pointer is a control some people never
 * get at all.
 */
test('the menu opens from the keyboard alone', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).focus();
  await signedIn.keyboard.press('Enter');

  await expect(signedIn.getByRole('menu', { name: 'Options for Grocery' })).toBeVisible();
});

test('Escape closes the menu', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await expect(signedIn.getByRole('menu')).toBeVisible();

  await signedIn.keyboard.press('Escape');
  await expect(signedIn.getByRole('menu')).toHaveCount(0);
});

test('rename changes the line everywhere', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Rename' }).click();
  await signedIn.getByLabel('Name', { exact: true }).fill('Groceries');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Groceries balance' })).toBeVisible();
});

test('a manual adjustment records a movement, not a new total', async ({ signedIn, api }) => {
  const id = await makeDelegation(api, 'Grocery');
  // Start it somewhere other than zero, so a delta and an absolute would differ.
  await api.post(`/api/delegations/${id}/adjust`, { data: { deltaCents: '65000' } });

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$650.00');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Manually adjust this line' }).click();
  await signedIn.getByLabel('Add or remove').fill('25.00');

  // The dialog says where the line lands, because the field is not the total.
  await expect(signedIn.getByText('$675.00')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Adjust', exact: true }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$675.00');
});

test('history shows the adjustment, which the Transactions page never does', async ({
  signedIn,
  api,
}) => {
  const id = await makeDelegation(api, 'Grocery');
  await api.post(`/api/delegations/${id}/adjust`, { data: { deltaCents: '2500' } });

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'History for this line' }).click();

  await expect(signedIn.getByRole('dialog')).toBeVisible();
  await expect(signedIn.getByText('Manual adjustment')).toBeVisible();
  await expect(signedIn.getByText('+$25.00')).toBeVisible();

  // The same event must not appear in the journal.
  await signedIn.goto('/transactions');
  await expect(signedIn.getByText('Manual adjustment')).toHaveCount(0);
});

test('archiving is refused while the line still holds money, and offers a way out', async ({
  signedIn,
  api,
}) => {
  const id = await makeDelegation(api, 'Grocery');
  await api.post(`/api/delegations/${id}/adjust`, { data: { deltaCents: '2500' } });

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  // The refusal names the amount, so the next step is obvious.
  await expect(signedIn.getByRole('alert')).toContainText('$25.00');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toBeVisible();

  // Adjust is offered inline, prefilled with the movement that zeroes the line.
  await signedIn.getByRole('button', { name: 'Adjust to zero' }).click();
  await expect(signedIn.getByLabel('Add or remove')).toHaveValue('-25.00');
  await signedIn.getByRole('button', { name: 'Adjust', exact: true }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('an empty line archives and leaves the table', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toHaveCount(0);
  await expect(signedIn.getByRole('button', { name: 'Household balance' })).toBeVisible();
});

test('a line can be moved into a grouping created on this page', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Add grouping' }).click();
  await signedIn.getByLabel('Add a grouping').fill('Essentials');
  await signedIn.getByLabel('Add a grouping').press('Enter');

  await expect(signedIn.getByRole('button', { name: /Essentials/ })).toBeVisible();

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Move to grouping' }).click();
  await signedIn.getByRole('menuitem', { name: 'Essentials' }).click();

  // Collapsing the grouping proves the row is inside it: the total appears on
  // the grouping row and the child row goes away.
  await expect(signedIn.getByRole('menu')).toHaveCount(0);
  await signedIn.getByRole('button', { name: /Essentials/ }).click();
  await expect(signedIn.getByText('(collapsed — 1 line)')).toBeVisible();
});

test('the utility toggle sticks', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Water');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Water' }).click();
  const toggle = signedIn.getByRole('switch', { name: 'Water is a utility' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();

  await signedIn.reload();
  await signedIn.getByRole('button', { name: 'Options for Water' }).click();
  await expect(signedIn.getByRole('switch', { name: 'Water is a utility' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('a note is written, shown in the menu, and can be cleared', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Car Insurance');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Add a note' }).click();
  await signedIn.getByLabel('Note', { exact: true }).fill('$2,200, Dec 27');
  await signedIn.getByRole('button', { name: 'Save note' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await expect(signedIn.getByText('$2,200, Dec 27')).toBeVisible();

  await signedIn.getByRole('menuitem', { name: 'Edit note' }).click();
  await signedIn.getByLabel('Note', { exact: true }).fill('');
  await signedIn.getByRole('button', { name: 'Save note' }).click();

  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await expect(signedIn.getByRole('menuitem', { name: 'Add a note' })).toBeVisible();
});
