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
  test('every setting changes the spacing and none of them the text', async ({
    signedIn: page,
    api,
  }) => {
    await makeDelegation(api, 'Grocery', '40000');
    await page.goto('/');

    const cell = page.locator('td.row-cell').first();
    const height = (): Promise<number> =>
      cell.evaluate((node) => node.getBoundingClientRect().height);

    // Compact is what an untouched device gets: the type size never changed with
    // this setting, so the extra air was only ever fewer envelopes on screen.
    expect(Math.round(await height())).toBe(32);
    const textSize = await cell.evaluate((node) => getComputedStyle(node).fontSize);

    for (const [label, expected] of [
      ['Comfortable', 40],
      ['Dense', 28],
      ['Compact', 32],
    ] as const) {
      await page.goto('/settings/display');
      await page.getByLabel(label).check();

      await page.goto('/');
      expect(Math.round(await height()), label).toBe(expected);

      // Only the spacing changes. A "denser" setting that also shrank the type
      // would be a different, worse thing.
      expect(await cell.evaluate((node) => getComputedStyle(node).fontSize), label).toBe(textSize);
    }
  });

  test('the choice survives a reload, on this device', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery', '40000');

    await page.goto('/settings/display');
    // Chosen away from the default, so the assertion proves a stored value
    // rather than the fallback.
    await page.getByLabel('Dense').check();
    await page.reload();

    await expect(page.getByLabel('Dense')).toBeChecked();
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
      // The column switcher is a row of the table it switches, so the table is
      // the ancestor rather than a sibling.
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.closest('table');
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
      // The column switcher is a row of the table it switches, so the table is
      // the ancestor rather than a sibling.
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.closest('table');
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
      // The column switcher is a row of the table it switches, so the table is
      // the ancestor rather than a sibling.
      const group = document.querySelector('[role="radiogroup"]');
      const table = group?.closest('table');
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

test.describe('the row menu on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  /** Presses and holds the first transaction row, in real touch events. */
  async function hold(page: Page, ms: number): Promise<void> {
    await page.evaluate(() => {
      const row = document.querySelector('main li');
      if (!row) throw new Error('no transaction row');
      const touch = new Touch({ identifier: 1, target: row, clientX: 120, clientY: 200 });
      row.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], bubbles: true }));
    });
    await page.waitForTimeout(ms);
  }

  async function aTransaction(page: Page, api: APIRequestContext): Promise<void> {
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
    // The row has to be on screen before touch events can be aimed at it.
    await expect(page.getByText('Corner Shop')).toBeVisible();
  }

  test('touch and hold opens it, where there is no hover to reveal it', async ({
    signedIn: page,
    api,
  }) => {
    await aTransaction(page, api);

    await hold(page, 700);

    await expect(page.getByRole('menu', { name: 'Options for Corner Shop' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Split between delegations' })).toBeVisible();
  });

  test('a tap is not a hold', async ({ signedIn: page, api }) => {
    await aTransaction(page, api);

    await hold(page, 150);
    await page.evaluate(() => {
      const row = document.querySelector('main li');
      const touch = new Touch({ identifier: 1, target: row!, clientX: 120, clientY: 200 });
      row!.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch], bubbles: true }));
    });
    await page.waitForTimeout(600);

    await expect(page.getByRole('menu', { name: 'Options for Corner Shop' })).toBeHidden();
  });

  /** A finger travelling down the page is scrolling, not holding a row. */
  test('scrolling away does not open it', async ({ signedIn: page, api }) => {
    await aTransaction(page, api);

    await hold(page, 150);
    await page.evaluate(() => {
      const row = document.querySelector('main li');
      const moved = new Touch({ identifier: 1, target: row!, clientX: 120, clientY: 40 });
      row!.dispatchEvent(new TouchEvent('touchmove', { touches: [moved], bubbles: true }));
    });
    await page.waitForTimeout(700);

    await expect(page.getByRole('menu', { name: 'Options for Corner Shop' })).toBeHidden();
  });
});

/**
 * Dark mode.
 *
 * Per device, like row density, and for the same reason: this describes the
 * screen somebody is looking at, not the household's budget. One person reading
 * in a dark room must not put the other's phone into dark mode.
 */
test.describe('theme', () => {
  test('light and dark are real palettes, not one with the colours inverted', async ({
    signedIn: page,
  }) => {
    await page.goto('/settings/display');

    const canvas = (): Promise<string> =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
      );
    const ink = (): Promise<string> =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-ink').trim(),
      );

    // `exact`: "Reading light" carries the word too, and an accessible name is
    // matched as a substring.
    await page.getByLabel('Light', { exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightCanvas = await canvas();
    const lightInk = await ink();

    await page.getByLabel('Dark', { exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await canvas()).not.toBe(lightCanvas);
    expect(await ink()).not.toBe(lightInk);

    // The ground genuinely darkened and the type genuinely lightened, rather
    // than the tokens merely differing.
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = /(\d+), (\d+), (\d+)/.exec(body)!.slice(1).map(Number) as [
      number,
      number,
      number,
    ];
    expect((r + g + b) / 3).toBeLessThan(60);

    // `color-scheme` so the browser draws checkboxes, selects and scrollbars
    // dark too. Without it those stay white rectangles in a dark page.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'dark',
    );
  });

  test('the choice survives a reload, and System follows the device', async ({
    signedIn: page,
  }) => {
    await page.goto('/settings/display');
    await page.getByLabel('Dark', { exact: true }).check();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel('Dark')).toBeChecked();

    // System resolves against the device rather than being stored as a third
    // value the stylesheet would have to understand.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByLabel('System').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // And an explicit choice is not overruled by the device changing.
    await page.getByLabel('Dark', { exact: true }).check();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
