import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Settings → Delegations, Groupings and Archived.
 *
 * The behaviour worth protecting is that archiving is a refusal rather than a
 * silent success when it would break something, and that an archived row can be
 * found and brought back — the whole point of never hard-deleting anything.
 */

test('a delegation is edited from Settings and the Budget agrees', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/delegations');
  await signedIn.getByRole('button', { name: /Grocery/ }).click();

  await signedIn.getByLabel('Name of Grocery').fill('Groceries');
  await signedIn.getByLabel('Amount to delegate for Grocery').fill('250.00');
  await signedIn.getByLabel('Note for Grocery').fill('Weekly shop');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Groceries balance' })).toBeVisible();
  await expect(
    signedIn.getByRole('button', { name: 'Groceries amount to delegate' }),
  ).toContainText('$250.00');
});

/**
 * Null is not zero. An emptied amount means "add nothing when Delegate is
 * pressed" and shows an em-dash; a typed zero is a deliberate zero.
 */
test('clearing the amount makes a line ad hoc rather than zero', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery', '25000');

  await signedIn.goto('/settings/delegations');
  await signedIn.getByRole('button', { name: /Grocery/ }).click();
  await signedIn.getByLabel('Amount to delegate for Grocery').fill('');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery amount to delegate' })).toContainText(
    '—',
  );
});

test('a grouping is created and renamed from Settings', async ({ signedIn }) => {
  await signedIn.goto('/settings/groupings');

  await signedIn.getByRole('button', { name: 'New grouping' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Create a grouping' });
  await dialog.getByLabel('Name').fill('Essentials');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  await signedIn.getByLabel('Name of Essentials').fill('Household costs');
  await signedIn.getByLabel('Name of Essentials').blur();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: /Household costs/ })).toBeVisible();
});

test('a grouping holding a live line refuses to archive', async ({ signedIn, api }) => {
  await signedIn.goto('/settings/groupings');
  await signedIn.getByRole('button', { name: 'New grouping' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Create a grouping' });
  await dialog.getByLabel('Name').fill('Essentials');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  // Put a delegation inside it, then try to archive the grouping.
  const delegationId = await makeDelegation(api, 'Grocery');
  const budget = await (await api.get('/api/budget')).json();
  const groupingId = (budget as { delegations: { groupings: { id: string }[] } }).delegations
    .groupings[0]?.id;
  await api.patch(`/api/delegations/${delegationId}`, { data: { groupingId } });

  await signedIn.goto('/settings/groupings');
  await signedIn.getByRole('button', { name: 'Archive Essentials' }).click();

  // Archiving it would orphan the line inside it.
  await expect(signedIn.getByRole('alert')).toContainText('live item');
});

test('an archived delegation is listed and can be restored', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/delegations');
  await signedIn.getByRole('button', { name: /Grocery/ }).click();
  await signedIn.getByRole('button', { name: 'Archive Grocery' }).click();

  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByText('Grocery')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Restore Grocery' }).click();
  await expect(signedIn.getByText('Nothing is archived.')).toBeVisible();

  // Back on the budget, where it was before.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toBeVisible();
});

test('an archived account is listed beside archived delegations', async ({ signedIn }) => {
  await makeAccount('Old Card', 'debt', 0n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Options for Old Card' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByRole('button', { name: 'Restore Old Card' })).toBeVisible();
});

test('Archived says so plainly when there is nothing in it', async ({ signedIn }) => {
  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByText('Nothing is archived.')).toBeVisible();
});
