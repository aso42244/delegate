import type { Page } from '@playwright/test';
import { expect, makeDelegation, test } from './fixtures.js';

/** Creates a grouping through the dialog the page now opens. */
async function makeGrouping(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New grouping' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a grouping' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
}

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
  await makeGrouping(signedIn, 'Essentials');

  // Each swatch is named, so the choice is not carried by colour alone.
  await signedIn.getByRole('button', { name: /^Colour for Essentials/ }).click();
  await signedIn.getByRole('button', { name: 'Blue for Essentials' }).click();

  // Choosing closes the popover, and the trigger names the colour it now holds —
  // which is the assertion that matters: the row says "Blue" without being
  // opened at all.
  await expect(signedIn.getByRole('button', { name: 'Colour for Essentials: Blue' })).toBeVisible();

  await signedIn.reload();
  await expect(signedIn.getByRole('button', { name: 'Colour for Essentials: Blue' })).toBeVisible();
});

test('colour can be taken off again', async ({ signedIn }) => {
  await signedIn.goto('/settings/groupings');
  await makeGrouping(signedIn, 'Essentials');

  await signedIn.getByRole('button', { name: /^Colour for Essentials/ }).click();
  await signedIn.getByRole('button', { name: 'Purple for Essentials' }).click();
  await expect(
    signedIn.getByRole('button', { name: 'Colour for Essentials: Purple' }),
  ).toBeVisible();

  await signedIn.getByRole('button', { name: /^Colour for Essentials/ }).click();
  await signedIn.getByRole('button', { name: 'No colour for Essentials' }).click();
  await expect(
    signedIn.getByRole('button', { name: 'Colour for Essentials: No colour' }),
  ).toBeVisible();
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

/**
 * Putting delegations in an order, and keeping it.
 *
 * Alphabetical was the only order the budget had, which is why a household ends
 * up naming its groupings "3 - Food" and "5 - Home" — numbering by hand to buy
 * back an ordering the software would not give them.
 *
 * The order is a column, not a preference: it is the same for everybody who
 * signs in, because it is a property of the budget rather than of a browser.
 */

/**
 * The delegation names on the Budget page, top to bottom.
 *
 * Read from the accessible name, not the text: the button's text is the money
 * it holds. Scoped to the third table, which is the Delegations section —
 * Assets and Debts label their rows the same way.
 */
async function order(page: import('@playwright/test').Page, expected: string[]): Promise<string[]> {
  // The rows have to be on screen before they can be read in order; without
  // this the first call runs against an empty table and reports no order at all.
  await expect(page.getByRole('button', { name: `${expected[0]!} balance` })).toBeVisible();

  const names = await page
    .locator('button[aria-label$=" balance"]')
    .evaluateAll((buttons) =>
      buttons.map((button) => (button.getAttribute('aria-label') ?? '').replace(/ balance$/, '')),
    );
  // Filtered to the lines this test made: Assets and Debts label their rows the
  // same way, and which sections are on screen depends on what else exists.
  return names.filter((name) => expected.includes(name));
}

test('a line is moved with the row menu, and stays there for everyone', async ({
  signedIn,
  api,
}) => {
  const NAMES = ['Apples', 'Bananas', 'Cherries'];
  for (const name of NAMES) await makeDelegation(api, name);

  await signedIn.goto('/');
  // Alphabetical to begin with, which is what the backfill preserves.
  expect(await order(signedIn, NAMES)).toEqual(['Apples', 'Bananas', 'Cherries']);

  await signedIn.getByRole('button', { name: 'Options for Cherries' }).click();
  await signedIn.getByRole('menuitem', { name: 'Move up' }).click();

  // Polled: the write and the refetch are two round trips, and reading the rows
  // straight after the click reads the order they were in before it.
  await expect.poll(() => order(signedIn, NAMES)).toEqual(['Apples', 'Cherries', 'Bananas']);

  // Stored, not remembered by this tab: a reload is a fresh read of the budget.
  await signedIn.reload();
  expect(await order(signedIn, NAMES)).toEqual(['Apples', 'Cherries', 'Bananas']);
});

test('the top line cannot be moved above itself', async ({ signedIn, api }) => {
  const NAMES = ['Apples', 'Bananas'];
  for (const name of NAMES) await makeDelegation(api, name);

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Options for Apples' }).click();
  await signedIn.getByRole('menuitem', { name: 'Move up' }).click();

  // Nothing to do, and nothing sent: the menu closes and the order is what it
  // was. Reloaded so this cannot pass on a stale render.
  await signedIn.reload();
  expect(await order(signedIn, NAMES)).toEqual(['Apples', 'Bananas']);
});
