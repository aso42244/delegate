import { expect, makeDelegation, test } from './fixtures.js';

/**
 * Grouping colour, and moving a line between groupings by dragging it.
 *
 * Colour comes from a curated palette rather than a picker, and drag and drop is
 * an addition rather than a replacement: "Move to grouping" in the row menu
 * stays the keyboard route, because dragging is not one.
 */

test('a grouping takes a colour from the palette, and the budget tints its rows', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/groupings');
  await signedIn.getByLabel('New grouping').fill('Essentials');
  await signedIn.getByRole('button', { name: 'Add grouping' }).click();
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  // Each swatch is named, so the choice is not carried by colour alone.
  await signedIn.getByRole('button', { name: 'Blue for Essentials' }).click();
  await expect(signedIn.getByRole('button', { name: 'Blue for Essentials' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await signedIn.reload();
  await expect(signedIn.getByRole('button', { name: 'Blue for Essentials' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('colour can be taken off again', async ({ signedIn }) => {
  await signedIn.goto('/settings/groupings');
  await signedIn.getByLabel('New grouping').fill('Essentials');
  await signedIn.getByRole('button', { name: 'Add grouping' }).click();
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Purple for Essentials' }).click();
  await expect(signedIn.getByRole('button', { name: 'Purple for Essentials' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await signedIn.getByRole('button', { name: 'No colour for Essentials' }).click();
  await expect(signedIn.getByRole('button', { name: 'No colour for Essentials' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

/**
 * The palette is enforced rather than merely offered — the UI is not the only
 * caller, and a rule only the UI observes is a rule the next caller ignores.
 */
test('the API refuses a colour outside the palette', async ({ api }) => {
  const created = await api.post('/api/groupings', {
    data: { name: 'Essentials', section: 'delegations' },
  });
  const { grouping } = (await created.json()) as { grouping: { id: string } };

  const response = await api.patch(`/api/groupings/${grouping.id}`, {
    data: { color: '#FF00FF' },
  });

  expect(response.status()).toBe(400);
});

test('dragging a delegation into a grouping moves it', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: /Essentials/ })).toBeVisible();

  // The row is the drag source; the grouping header is the target.
  const row = signedIn.getByRole('row').filter({ hasText: 'Grocery' });
  const target = signedIn.getByRole('row').filter({ hasText: 'Essentials' });
  await row.dragTo(target);

  // Collapsing proves it landed inside: the child count is on the grouping row.
  await signedIn.getByRole('button', { name: /Essentials/ }).click();
  await expect(signedIn.getByText('(collapsed — 1 line)')).toBeVisible();
});

test('the row menu remains the route that works without a mouse', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Grocery' }).focus();
  await signedIn.keyboard.press('Enter');
  await signedIn.getByRole('menuitem', { name: 'Move to grouping' }).click();
  await signedIn.getByRole('menuitem', { name: 'Essentials' }).click();

  await signedIn.getByRole('button', { name: /Essentials/ }).click();
  await expect(signedIn.getByText('(collapsed — 1 line)')).toBeVisible();
});
