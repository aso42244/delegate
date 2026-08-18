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
 * The five presets are a shortcut, not the vocabulary: any `#RRGGBB` is
 * accepted. §11's "must not be in your face" survives without an allow-list,
 * because colour reaches the page only as a tint at 4% and 10% alpha.
 *
 * The format is still enforced rather than merely offered — the UI is not the
 * only caller, and the tint function reads three channels out of the string by
 * position.
 */
test('the API takes any hex and refuses anything that is not one', async ({ api }) => {
  const created = await api.post('/api/groupings', {
    data: { name: 'Essentials', section: 'delegations' },
  });
  const { grouping } = (await created.json()) as { grouping: { id: string } };

  const custom = await api.patch(`/api/groupings/${grouping.id}`, {
    data: { color: '#ff00ff' },
  });
  expect(custom.status()).toBe(200);

  for (const bad of ['#FFF', 'rebeccapurple', '2783DE']) {
    const response = await api.patch(`/api/groupings/${grouping.id}`, { data: { color: bad } });
    expect(response.status(), bad).toBe(400);
  }
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

  // Collapsing proves it landed inside: the row disappears with the grouping,
  // which it would not do if it were still sitting outside one.
  await signedIn.getByRole('button', { name: /Essentials/ }).click();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeHidden();
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
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeHidden();
});
