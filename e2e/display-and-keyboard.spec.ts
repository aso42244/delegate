import { expect, test, makeAccount, makeDelegation } from './fixtures.js';

/**
 * Row density, the phone layout of the budget, and keyboard row navigation.
 *
 * The assertion that earns its place is the one about typing: every row in the
 * transaction queue contains a text field, and `j` has to mean "next row" in the
 * table and the letter j inside the field. Getting that backwards makes the
 * queue unusable in a way no other test would notice.
 */

test.describe('row density', () => {
  test('compact shrinks the rows without shrinking the text', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.goto('/');

    const cell = page.locator('td.row-cell').first();
    const comfortable = await cell.evaluate((node) => node.getBoundingClientRect().height);
    const textSize = await cell.evaluate((node) => getComputedStyle(node).fontSize);
    expect(Math.round(comfortable)).toBe(40);

    await page.goto('/settings/display');
    await page.getByLabel('Compact').check();

    await page.goto('/');
    const compact = await cell.evaluate((node) => node.getBoundingClientRect().height);
    expect(Math.round(compact)).toBe(32);

    // Only the spacing changes. A "denser" setting that also shrank the type
    // would be a different, worse thing.
    expect(await cell.evaluate((node) => getComputedStyle(node).fontSize)).toBe(textSize);
  });

  test('the choice survives a reload, on this device', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');

    await page.goto('/settings/display');
    await page.getByLabel('Compact').check();
    await page.reload();

    await expect(page.getByLabel('Compact')).toBeChecked();
  });
});

test.describe('the budget on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('shows one amount at a time, switched by the control', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.goto('/');

    // Remaining first: it is the number the budget is read for.
    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'To delegate' })).toBeHidden();

    await page.getByRole('radio', { name: 'To delegate' }).click();

    await expect(page.getByRole('columnheader', { name: 'To delegate' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeHidden();
  });

  test('swiping across the table switches the amount', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.goto('/');

    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();

    // Real TouchEvents, dispatched in the page: the handler reads clientX off
    // the touch list, so anything simpler would not exercise it.
    await page.evaluate(() => {
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.parentElement?.querySelector('table');
      if (!table) throw new Error('no split-column table');
      const touch = (x: number): Touch =>
        new Touch({ identifier: 1, target: table, clientX: x, clientY: 200 });

      table.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(300)], bubbles: true }));
      table.dispatchEvent(
        new TouchEvent('touchend', { changedTouches: [touch(100)], bubbles: true }),
      );
    });

    await expect(page.getByRole('columnheader', { name: 'To delegate' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeHidden();

    // And back the other way.
    await page.evaluate(() => {
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.parentElement?.querySelector('table');
      if (!table) throw new Error('no split-column table');
      const touch = (x: number): Touch =>
        new Touch({ identifier: 1, target: table, clientX: x, clientY: 200 });

      table.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
      table.dispatchEvent(
        new TouchEvent('touchend', { changedTouches: [touch(300)], bubbles: true }),
      );
    });

    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();
  });

  test('a vertical scroll does not change the amount', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.goto('/');
    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();

    // Diagonal, but mostly vertical: someone scrolling with their thumb must not
    // find the column swapped underneath it.
    await page.evaluate(() => {
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.parentElement?.querySelector('table');
      if (!table) throw new Error('no split-column table');
      const at = (x: number, y: number): Touch =>
        new Touch({ identifier: 1, target: table, clientX: x, clientY: y });

      table.dispatchEvent(new TouchEvent('touchstart', { touches: [at(200, 400)], bubbles: true }));
      table.dispatchEvent(
        new TouchEvent('touchend', { changedTouches: [at(140, 120)], bubbles: true }),
      );
    });

    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();
  });

  test('both amounts show side by side once there is room', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'To delegate' })).toBeVisible();
    // And the switch disappears with the need for it.
    await expect(page.getByRole('radiogroup', { name: 'Which amount to show' })).toBeHidden();
  });
});

test.describe('keyboard navigation', () => {
  test('j, k and the arrow keys move between rows', async ({ signedIn: page, api }) => {
    const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
    await makeDelegation(api, 'Grocery');

    for (const description of ['First Merchant', 'Second Merchant', 'Third Merchant']) {
      await api.post('/api/transactions', {
        data: { accountId, amountCents: '-1000', description, postedAt: '2026-08-05T00:00:00Z' },
      });
    }

    await page.goto('/transactions');

    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(3);

    await rows.first().focus();
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toBeFocused();

    // Clamped, not wrapped: the end of the queue is the end.
    await page.keyboard.press('j');
    await expect(rows.nth(2)).toBeFocused();

    await page.keyboard.press('k');
    await expect(rows.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toBeFocused();

    await page.keyboard.press('End');
    await expect(rows.nth(2)).toBeFocused();

    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
  });

  /**
   * The one that matters. Every row holds a categorize field, and a person
   * typing a delegation name that happens to contain j or k must get the
   * letters.
   */
  test('typing in a field is typing, not navigation', async ({ signedIn: page, api }) => {
    const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
    await makeDelegation(api, 'Jam and Jelly');
    await api.post('/api/transactions', {
      data: {
        accountId,
        amountCents: '-1000',
        description: 'Corner Shop',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });

    await page.goto('/transactions');

    const field = page.getByLabel('Categorize Corner Shop');
    await field.fill('jjkk');
    await expect(field).toHaveValue('jjkk');
  });

  test('Enter steps into the row it is on', async ({ signedIn: page, api }) => {
    const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
    await makeDelegation(api, 'Grocery');
    await api.post('/api/transactions', {
      data: {
        accountId,
        amountCents: '-1000',
        description: 'Corner Shop',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });

    await page.goto('/transactions');

    await page.locator('tbody tr').first().focus();
    await page.keyboard.press('Enter');

    await expect(page.getByLabel('Categorize Corner Shop')).toBeFocused();
  });
});
