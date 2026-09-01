import { expect, makeAccount, makeDelegation, makePendingSpend, test } from './fixtures.js';

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
   * The sheet fits above the software keyboard.
   *
   * A phone keyboard does not shrink the window. It is drawn over the page, so
   * `position: fixed` — which is laid out against the window — keeps anchoring
   * a sheet to a bottom edge that is now underneath 414px of keys. Measured
   * before the fix, at 390x844 with the keyboard up, the categorization sheet
   * ran from y=264 to y=844: its first option was the last thing above the
   * fold, and Cancel sat 361px below a screen edge that does not scroll.
   *
   * Chromium has no software keyboard, so the visual viewport is stubbed to the
   * shape iOS gives it: a window that is still 844 tall with only 430 of it on
   * screen. That is the whole of the condition — the layout viewport and the
   * visual viewport disagreeing — and it is what the fix reads.
   */
  test('the categorization sheet fits above the keyboard', async ({ signedIn: page, api }) => {
    const VISIBLE = 430;

    const accountId = await makeAccount('Everyday Checking', 'asset', 500_000n);
    for (const name of ['Grocery', 'Gas', 'Dining', 'Home', 'Health', 'Pets', 'Travel', 'Gifts']) {
      await makeDelegation(api, name);
    }
    await api.post('/api/transactions', {
      data: {
        accountId,
        amountCents: '-4210',
        description: 'WHOLE FOODS MKT',
        postedAt: '2026-08-23T00:00:00Z',
      },
    });

    await page.addInitScript((visible: number) => {
      // An EventTarget, because the page subscribes to resize and scroll on it.
      const stub = new EventTarget() as EventTarget & Record<string, number>;
      Object.assign(stub, { width: 390, height: visible, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { value: stub, configurable: true });
    }, VISIBLE);

    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Categorize WHOLE FOODS MKT' }).click();

    const sheet = page.getByRole('dialog', { name: 'Categorize WHOLE FOODS MKT' });
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    // The whole sheet is above the keyboard, not merely its top.
    expect(box!.y + box!.height).toBeLessThanOrEqual(VISIBLE);

    // Cancel is in the footer, so it stays on screen however many options the
    // list holds — the body scrolls under it rather than pushing it down.
    const cancel = await sheet.getByRole('button', { name: 'Cancel' }).boundingBox();
    expect(cancel).not.toBeNull();
    expect(cancel!.y + cancel!.height).toBeLessThanOrEqual(VISIBLE);

    // And the list is usable: the first match is on screen, and the last is one
    // scroll away inside the sheet rather than off the end of the screen.
    const first = await sheet.getByRole('option').first().boundingBox();
    expect(first!.y + first!.height).toBeLessThanOrEqual(VISIBLE);

    const last = sheet.getByRole('option').last();
    await last.scrollIntoViewIfNeeded();
    const scrolled = await last.boundingBox();
    expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(VISIBLE);
    await last.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
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

/**
 * Nothing runs off the side, and nothing takes two lines to say one thing.
 *
 * Both were true across the application and neither showed up in a test: a table
 * of fixed columns came to 456px inside a 326px card and drew its headers on top
 * of each other, the Insights window picker put 138px and its last option past
 * the edge of the screen, and a chip beside an account name wrapped onto a line
 * of its own and doubled the height of every row it happened to.
 *
 * Measured rather than eyeballed, because every one of those was visible in a
 * screenshot for weeks and none of them was noticed.
 */
test.describe('at 390px, on every screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const ROUTES = [
    '/',
    '/transactions',
    '/utilities',
    '/insights',
    '/settings/sync',
    '/settings/accounts',
    '/settings/delegations',
    '/settings/groupings',
    '/settings/rules',
    '/settings/bitcoin',
    '/settings/properties',
    '/settings/budget',
    '/settings/users',
    '/settings/tor',
    '/settings/display',
    '/settings/archived',
  ] as const;

  /** Enough in the budget that the pages are not all empty states. */
  async function household(api: import('@playwright/test').APIRequestContext): Promise<void> {
    const card = await makeAccount(
      'Costco Citi VISA',
      'debt',
      560_983n,
      'simplefin',
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    );
    await makeAccount('Frontier Checking', 'asset', 1_204_112n, 'simplefin', new Date());
    await makeAccount('Physical Cash', 'asset', 20_000n);

    const groceries = await makeDelegation(api, 'Groceries', '80000');
    const water = await makeDelegation(api, 'Water and sewer', '9800');
    await makeDelegation(api, 'Family Investment', '50000');
    await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

    // Real-shaped descriptions: long, uppercase, and with no natural break.
    await makePendingSpend(card, groceries, -42208n, 'COSTCO WHSE #1159 SIOUX FALLS US');
    await makePendingSpend(card, water, -9800n, 'CITY OF SIOUX FALLS UTILITIES');
  }

  /**
   * The `⋯` is replaced by touch-and-hold, not removed.
   *
   * Two halves, and the second is the one that matters: a long press is not a
   * gesture VoiceOver can perform, so the trigger keeps its place in the
   * accessibility tree and loses only its pixels. `display: none` would have
   * taken 40px back and stranded every row menu for anyone using a screen
   * reader.
   */
  test('the row menu is a long press, and its trigger is still there to be found', async ({
    signedIn: page,
    api,
  }) => {
    await makeDelegation(api, 'Groceries', '80000');
    await page.goto('/');

    const trigger = page.getByRole('button', { name: 'Options for Groceries' });

    // Not painted, and taking no room.
    await expect(trigger).not.toBeVisible();
    const width = await page
      .locator('td.hold-to-open-cell')
      .first()
      .evaluate((cell) => cell.getBoundingClientRect().width);
    expect(width).toBe(0);

    // Still in the tree, so a screen reader can reach what a long press cannot.
    await expect(trigger).toBeAttached();

    // And the gesture that replaced it works. Real touch events rather than a
    // synthesised pointer sequence: `useLongPress` listens for the former, and
    // a test that fakes the wrong one proves the trigger is hidden and nothing
    // about whether anything replaced it.
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) =>
        (tr.textContent || '').includes('Groceries'),
      );
      if (!row) throw new Error('no Groceries row');
      const touch = new Touch({ identifier: 1, target: row, clientX: 120, clientY: 200 });
      row.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], bubbles: true }));
    });
    await page.waitForTimeout(700);

    await expect(page.getByRole('menu', { name: 'Options for Groceries' })).toBeVisible();
  });

  /**
   * The Insights order is reachable under a thumb.
   *
   * HTML5 drag fires no events on a touchscreen, so the grid's only way to
   * reorder was one that could not be performed there — and the drag handle was
   * still drawn, a grip on nothing.
   */
  test('a tile can be reordered, and the drag handle is not drawn', async ({ signedIn: page }) => {
    await page.goto('/insights');
    await expect(page.locator('section h2').nth(1)).toBeVisible();

    const titles = (): Promise<string[]> => page.locator('section h2').allInnerTexts();
    const second = (await titles())[1]!;

    // The arrows are visible without a hover, because there is none to give.
    const up = page.getByRole('button', { name: `Move ${second} earlier` });
    await expect(up).toBeVisible();
    await up.tap();
    await expect.poll(async () => (await titles())[0]).toBe(second);

    // And the handle, which only a pointer can use, is not taking up room.
    await expect(page.locator('.pointer-only').first()).not.toBeVisible();
  });

  test('nothing is clipped by the edge of the screen', async ({ signedIn: page, api }) => {
    await household(api);

    for (const route of ROUTES) {
      await page.goto(route);
      // Waited for rather than slept on: the tables these check are drawn from
      // a query, and measuring an empty page proves nothing. The tab bar rather
      // than the heading — a settings sub-page shows a back link instead of one.
      await expect(page.getByRole('link', { name: 'Budget' })).toBeVisible();

      const past = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        // Something inside a container that scrolls sideways is reachable, which
        // is the difference between an option you can get to and one you cannot.
        const scrolls = (el: Element): boolean => {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const overflow = getComputedStyle(n).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') return true;
          }
          return false;
        };
        return Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            return (r.right > vw + 1 || r.left < -1) && !scrolls(el);
          })
          .map(
            (el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 60)}`,
          )
          .slice(0, 4);
      });

      expect(past, `${route} pushes content past the edge`).toEqual([]);
    }
  });

  test('no name, heading, cell or control takes a second line', async ({ signedIn: page, api }) => {
    await household(api);

    for (const route of ROUTES) {
      await page.goto(route);
      // Waited for rather than slept on: the tables these check are drawn from
      // a query, and measuring an empty page proves nothing. The tab bar rather
      // than the heading — a settings sub-page shows a back link instead of one.
      await expect(page.getByRole('link', { name: 'Budget' })).toBeVisible();

      const wrapped = await page.evaluate(() => {
        // Prose is allowed to wrap — an error message that truncates is worse
        // than one that takes two lines. Everything that lines up in a column is
        // not: a heading, a cell, a button, a chip.
        const shouldNotWrap = 'h1, h2, h3, th, td, button, label, dt, dd';
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(shouldNotWrap))) {
          for (const node of Array.from(el.childNodes)) {
            if (node.nodeType !== Node.TEXT_NODE) continue;
            if (!(node.textContent || '').trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            // One rect per fragment, so distinct tops is the line count.
            const tops = new Set<number>();
            for (const rect of Array.from(range.getClientRects())) {
              if (rect.height > 0) tops.add(Math.round(rect.top));
            }
            if (tops.size > 1) out.push(`"${(node.textContent || '').trim().slice(0, 40)}"`);
          }
        }
        return out.slice(0, 4);
      });

      expect(wrapped, `${route} wraps something that should hold one line`).toEqual([]);
    }
  });
});
