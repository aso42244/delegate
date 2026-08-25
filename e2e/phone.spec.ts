import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Delegate on a phone.
 *
 * A 390×844 viewport with touch, which is the combination that changes the
 * layout: `NARROW` decides which of two layouts renders, and `(hover: none)`
 * decides whether the controls that hide on hover are reachable at all.
 *
 * The claims worth guarding are not "it fits". They are that the five
 * destinations are reachable without the sidebar, that a charge can be
 * categorized with a thumb, and that no control is left behind a hover a
 * touchscreen cannot perform.
 */
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('navigation is a tab bar, and the sidebar is gone', async ({ signedIn: page }) => {
    await page.goto('/');

    const tabs = page.getByRole('navigation', { name: 'Pages' });
    await expect(tabs).toBeVisible();
    // The sidebar is not narrowed to its rail — it is not rendered at all.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

    await tabs.getByRole('link', { name: 'Transactions' }).click();
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();

    await tabs.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  /**
   * The reason this page is opened on a phone at all: a charge lands while you
   * are out. A chip rather than a field, and a sheet rather than a popover.
   */
  test('a charge is categorized from a chip and a sheet', async ({ signedIn: page, api }) => {
    const accountId = await makeAccount('Everyday Checking', 'asset', 500_000n);
    await makeDelegation(api, 'Grocery');
    await api.post('/api/transactions', {
      data: {
        accountId,
        amountCents: '-4210',
        description: 'WHOLE FOODS MKT',
        postedAt: '2026-08-23T00:00:00Z',
      },
    });

    await page.goto('/transactions');

    const chip = page.getByRole('button', { name: 'Categorize WHOLE FOODS MKT' });
    await expect(chip).toHaveText('Categorize');
    await chip.click();

    const sheet = page.getByRole('dialog', { name: 'Categorize WHOLE FOODS MKT' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('option', { name: 'Grocery' }).click();

    // The sheet closes on a choice, and the chip becomes the answer.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(chip).toHaveText('Grocery');

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');
  });

  /**
   * Thirteen tabs do not fit; about four do. The index is the phone's own idiom
   * for this, and the back link has to return to it rather than to a redirect
   * that bounces forward again.
   */
  test('settings is an index, and a section comes back to it', async ({ signedIn: page }) => {
    await page.goto('/settings');

    await expect(page.getByRole('link', { name: /^Delegations/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);

    await page.getByRole('link', { name: /^Accounts/ }).click();
    await expect(page).toHaveURL(/\/settings\/accounts$/);

    // "Back to Settings", not "Settings": the tab bar links there too, and two
    // links with one name is ambiguous to anyone navigating by name.
    await page.getByRole('link', { name: 'Back to Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('link', { name: /^Rules/ })).toBeVisible();
  });

  /**
   * Both lived only in the sidebar, which a phone never draws — so the page
   * named after the connection could report on it and not run it.
   */
  test('sync and sign out have homes outside the sidebar', async ({ signedIn: page }) => {
    await page.goto('/settings/users');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  /**
   * The row menu is `opacity: 0` until hover, and a phone cannot hover. Before
   * this it was reachable only where a long-press had been wired, which left a
   * grouping's Archive unreachable by any means at all.
   */
  test('controls that hide on hover are reachable', async ({ signedIn: page, api }) => {
    await makeDelegation(api, 'Grocery');
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Options for Grocery' })).toBeVisible();
  });
});

/**
 * The desktop keeps everything it had. The tab bar is a phone control and the
 * sidebar is the wide one; neither should appear at the other's width.
 */
test('a wide screen keeps the sidebar and the settings tabs', async ({ signedIn: page }) => {
  await page.goto('/settings');

  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Pages' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  // `/settings` still lands on Sync where there are tabs to land among.
  await expect(page).toHaveURL(/\/settings\/sync$/);
});
