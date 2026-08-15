import { expect, test, makeAccount, makeDelegation } from './fixtures.js';

/**
 * The five display changes, each asserted through the screen that was wrong.
 *
 * Four of the five were only visible with real data on a real page — a tile with
 * no way to move it, an amount broken across two lines, a bank name filling a
 * column. So these drive the interface rather than the API.
 */

test.describe('insights tiles', () => {
  test('move earlier and later, and the order survives a reload', async ({ signedIn: page }) => {
    await page.goto('/insights');

    const titles = page.locator('section h2');
    const first = await titles.first().innerText();
    const second = await titles.nth(1).innerText();
    expect(first).not.toBe(second);

    await page.getByRole('button', { name: `Move ${second} earlier` }).click();
    await expect(titles.first()).toHaveText(second);

    await page.reload();
    await expect(page.locator('section h2').first()).toHaveText(second);
  });

  test('the first tile cannot move earlier', async ({ signedIn: page }) => {
    await page.goto('/insights');
    const first = await page.locator('section h2').first().innerText();

    await expect(page.getByRole('button', { name: `Move ${first} earlier` })).toBeDisabled();
  });

  test('a tile can be drawn a different way, and remembers it', async ({ signedIn: page }) => {
    await page.goto('/insights');

    const donut = page.getByRole('button', { name: 'Show Spending by grouping as Donut' });
    await donut.click();
    await expect(donut).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Show Spending by grouping as Donut' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('drag a tile onto another and it takes that place', async ({ signedIn: page }) => {
    await page.goto('/insights');

    const titles = page.locator('section h2');
    const third = (await titles.nth(2).innerText()).trim();

    // HTML5 drag-and-drop: Playwright's dragTo drives the real events.
    await page.locator('section').nth(2).dragTo(page.locator('section').first());

    await expect(titles.first()).toContainText(third);
    await page.reload();
    await expect(page.locator('section h2').first()).toContainText(third);
  });

  /** A single number has one honest shape, so no switch is offered at all. */
  test('a tile with one sensible shape offers no switch', async ({ signedIn: page }) => {
    await page.goto('/insights');

    await expect(page.getByRole('button', { name: /Show Uncategorized as/ })).toHaveCount(0);
  });
});

test('a grouping takes a colour outside the five presets', async ({ signedIn: page, api }) => {
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });
  await page.goto('/settings/groupings');

  const hex = page.getByLabel('Colour hex for Essentials');
  await hex.fill('#123ABC');
  await hex.press('Enter');

  await page.reload();
  await expect(page.getByLabel('Colour hex for Essentials')).toHaveValue('#123ABC');
});

test('an account nickname replaces the long name on the budget', async ({
  signedIn: page,
  api,
}) => {
  const accountId = await makeAccount(
    'Citibank Costco VISA Costco Anywhere Visa Card by Citi-7459',
    'debt',
    50000n,
  );
  expect(accountId).toBeTruthy();
  await makeDelegation(api, 'Grocery');

  await page.goto('/settings/accounts');
  const nickname = page.getByLabel(
    'Short name for Citibank Costco VISA Costco Anywhere Visa Card by Citi-7459',
  );
  await nickname.fill('Costco Visa');
  await nickname.press('Enter');

  // The budget shows the short one; Settings keeps the full one, because that is
  // where identifying the account is the point.
  await page.goto('/');
  await expect(page.getByText('Costco Visa')).toBeVisible();
  await expect(page.getByText('Citibank Costco VISA', { exact: false })).toBeHidden();

  await page.goto('/settings/accounts');
  // `.first()`: the full name appears both as the row's label and inside the
  // nickname field's accessible name.
  await expect(page.getByText('Citibank Costco VISA', { exact: false }).first()).toBeVisible();
});

test('an amount and its sign stay on one line', async ({ signedIn: page, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const created = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '352763',
      description: 'ONLINE PAYMENT, THANK YOU',
      postedAt: '2026-08-05T00:00:00Z',
      kind: 'income',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  // Income leaves the uncategorized queue by design, so turn the filter off.
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Uncategorized' }).click();
  await expect(page.getByText('waiting to be categorized')).toBeHidden();

  const amount = page.locator('td.money span').first();
  await expect(amount).toContainText('3,527.63');

  /**
   * Measured on the span rather than the cell: the cell is a fixed 40px by
   * design, so its height says nothing about whether the text inside wrapped.
   * A client rect per line is what actually answers the question.
   */
  const lineCount = await amount.evaluate((node) => node.getClientRects().length);
  expect(lineCount).toBe(1);
});
