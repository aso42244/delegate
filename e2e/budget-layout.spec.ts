import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * The two arrangements of the Budget page, chosen on Settings → Display.
 *
 * What is worth asserting is the **order**, because that is the whole of the
 * difference: `stacked` reads Assets, Debts, Delegations, and `columns` puts
 * the envelopes first and the accounts beside them. On a narrow screen the grid
 * does not apply, so `columns` becomes a stack that keeps its own order — which
 * is the case a screenshot on a laptop would never show.
 */

/**
 * Asserts the section headings, in the order the page renders them.
 *
 * `toHaveText` with an array rather than reading `allInnerTexts()` and comparing:
 * the second is a single read that happens whenever it happens, and the budget
 * arrives from a query — so it caught an empty page and reported an empty array,
 * intermittently. This retries until the sections are there, which is what a
 * web-first assertion is for.
 */
async function expectSections(
  page: import('@playwright/test').Page,
  order: string[],
): Promise<void> {
  await expect(page.locator('main h2')).toHaveText(order);
}

async function seed(api: import('@playwright/test').APIRequestContext): Promise<void> {
  await makeAccount('Frontier Checking', 'asset', 1393256n);
  await makeAccount('Costco Citi VISA', 'debt', 685595n);
  await makeDelegation(api, 'Tithe', '57500');
}

/** Sets the preference through the control that owns it, not through storage. */
async function choose(
  page: import('@playwright/test').Page,
  label: 'Stacked' | 'Two columns',
): Promise<void> {
  await page.goto('/settings/display');
  await page.getByLabel(label).check();
  await expect(page.getByLabel(label)).toBeChecked();
}

test('stacked is the default, and reads Assets, Debts, Delegations', async ({ signedIn, api }) => {
  await seed(api);
  await signedIn.goto('/');

  await expectSections(signedIn, ['Assets', 'Debts', 'Delegations']);
});

test('two columns puts the envelopes first and the accounts beside them', async ({
  signedIn,
  api,
}) => {
  await seed(api);
  await choose(signedIn, 'Two columns');
  await signedIn.goto('/');

  // The DOM order is the column order: Delegations is the left column, and
  // Assets and Debts are the right one, stacked within it.
  await expectSections(signedIn, ['Delegations', 'Assets', 'Debts']);

  // Genuinely side by side rather than merely reordered — the accounts start
  // to the right of where the delegations table ends.
  const delegations = await signedIn
    .locator('section')
    .filter({ hasText: 'Delegations' })
    .first()
    .boundingBox();
  const assets = await signedIn
    .locator('section')
    .filter({ hasText: 'Assets' })
    .first()
    .boundingBox();

  expect(assets!.x).toBeGreaterThan(delegations!.x + delegations!.width - 1);
});

/**
 * The case a wide screen cannot show. Below `lg` there is no room for two
 * columns, so the grid does not apply — and what is left has to be this
 * arrangement's own order rather than a silent fall back to the other one.
 */
test('on a phone, two columns becomes Delegations, Assets, Debts', async ({ signedIn, api }) => {
  await seed(api);
  await choose(signedIn, 'Two columns');

  await signedIn.setViewportSize({ width: 390, height: 844 });
  await signedIn.goto('/');

  await expectSections(signedIn, ['Delegations', 'Assets', 'Debts']);

  // One column, so nothing sits beside anything.
  const delegations = await signedIn
    .locator('section')
    .filter({ hasText: 'Delegations' })
    .first()
    .boundingBox();
  const assets = await signedIn
    .locator('section')
    .filter({ hasText: 'Assets' })
    .first()
    .boundingBox();

  expect(assets!.y).toBeGreaterThan(delegations!.y);
  expect(assets!.x).toBe(delegations!.x);
});

test('the choice survives a reload, because it is remembered on the device', async ({
  signedIn,
  api,
}) => {
  await seed(api);
  await choose(signedIn, 'Two columns');

  await signedIn.goto('/');
  await signedIn.reload();
  await expectSections(signedIn, ['Delegations', 'Assets', 'Debts']);

  // And back, so the control is not one-way.
  await choose(signedIn, 'Stacked');
  await signedIn.goto('/');
  await expectSections(signedIn, ['Assets', 'Debts', 'Delegations']);
});

/**
 * The thing most likely to have been broken by moving the table into a grid
 * track: a grouping still folds, and folding it does not disturb the column.
 */
test('a grouping still folds inside the left column', async ({ signedIn, api }) => {
  await seed(api);
  await makeDelegation(api, 'Grocery');
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });

  await choose(signedIn, 'Two columns');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Move to grouping' }).click();
  await signedIn.getByRole('menuitem', { name: 'Essentials' }).click();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();

  const toggle = signedIn
    .getByRole('row')
    .filter({ hasText: 'Essentials' })
    .getByRole('button')
    .first();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeHidden();

  // Still two columns afterwards: a table that shrinks must not pull the
  // accounts under it.
  await expectSections(signedIn, ['Delegations', 'Assets', 'Debts']);
});
