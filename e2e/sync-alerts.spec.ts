import type { Locator, Page } from '@playwright/test';
import { expect, makeSyncFailure, makeSyncWarning, test } from './fixtures.js';

/**
 * What the application says about a sync, and where.
 *
 * SimpleFIN reports an expired bank login per-institution without failing the
 * run, because the other institutions synced fine. That was recorded on the run
 * from the beginning but legible only on the Settings page, so an account could
 * quietly stop updating while everything else looked healthy.
 *
 * These used to be tags of their own: full-width bars, then pills beside the
 * page title, then a column at the foot of the sidebar. They are **inside the
 * Sync SimpleFIN button** now. Five yellow pills stacked directly above a yellow
 * button, every one of them answered by looking at the same connection, was one
 * sentence said five times — and it crowded out the alerts the feed has nothing
 * to do with. The button takes the colour of the loudest, and the whole list
 * opens on hover and on focus.
 */

const WARNING = 'Connection to Frontier Bank may need attention. Auth required';

/** The control, which is the only face these conditions have now. */
function syncButton(page: Page): Locator {
  return page.getByRole('button', { name: /Sync SimpleFIN/ });
}

test('a feed complaint is folded into Sync, on every page, and names the bank', async ({
  signedIn,
}) => {
  await makeSyncWarning(WARNING);
  await signedIn.reload();

  // No tag of its own anywhere.
  await expect(signedIn.getByRole('link', { name: 'Sync issue' })).toHaveCount(0);

  const button = syncButton(signedIn);
  await expect(button).toBeVisible();

  /*
   * A hidden panel is out of the accessibility tree entirely, so nothing can ask
   * about it by role until it is revealed — which is also the behaviour worth
   * testing: the button is quiet until somebody reaches for it.
   */
  await expect(signedIn.getByRole('tooltip')).toHaveCount(0);
  await button.hover();
  const panel = signedIn.getByRole('tooltip');
  await expect(panel).toContainText('Sync issue');
  // The bank's name is the part that matters and the part a pill cannot carry.
  await expect(panel).toContainText(WARNING);

  // Every row is still a link to where the condition is dealt with, and the
  // panel takes the pointer so it can be reached rather than merely read.
  await panel.getByRole('link', { name: /Sync issue/ }).click();
  await expect(signedIn).toHaveURL(/\/settings\/sync$/);

  // On every page, because the sidebar is.
  for (const path of ['/transactions', '/recurring', '/overview', '/settings']) {
    await signedIn.goto(path);
    await syncButton(signedIn).hover();
    await expect(signedIn.getByRole('tooltip')).toContainText(WARNING);
  }
});

/**
 * The keyboard gets the same list.
 *
 * Hover is a pointer's gesture, and the panel is the only place these sentences
 * exist now — so a reader who tabs to the button has to be handed them too, or
 * the fold would have hidden a failing bank feed from them entirely.
 */
test('the folded list opens on focus as well as on hover', async ({ signedIn }) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  await expect(signedIn.getByRole('tooltip')).toHaveCount(0);
  await syncButton(signedIn).focus();
  await expect(signedIn.getByRole('tooltip')).toContainText(
    'Balances and transactions are not up to date',
  );
});

/**
 * A failing run is the loudest thing this application says, and the button says
 * it — in colour, in words, and without a row of the page.
 */
test('a failing sync paints the Sync button, not a band above the page', async ({ signedIn }) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const button = syncButton(signedIn);

  // Red, which is the `danger` variant's own soft fill. The colour is never the
  // only carrier — the words are one hover away and asserted above.
  await expect(button).toHaveClass(/border-danger-line/);

  /*
   * In the sidebar, and nothing above the page.
   *
   * The band pushing the budget down the screen is still the thing being ruled
   * out; what carries the condition has simply moved from a pill at the foot of
   * the navigation into the control directly under it.
   */
  const nav = await signedIn.getByRole('navigation', { name: 'Main' }).boundingBox();
  const heading = await signedIn.getByRole('heading', { name: 'Budget' }).boundingBox();
  const box = await button.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(nav!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(nav!.x + nav!.width);
  // Nothing has been inserted above the title.
  expect(heading!.y).toBeLessThan(120);
});

/**
 * Nothing can be put away any more, at any severity.
 *
 * Snoozing existed because a bar was in the way — it was a snooze rather than a
 * clear, so the interface never told a lie on the owner's behalf about a
 * condition that still held. Neither a tag nor a fold is in the way, so there is
 * nothing to put away and what makes one go away is fixing the thing.
 */
test('no notification offers a dismissal', async ({ signedIn }) => {
  await makeSyncWarning(WARNING);
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  await syncButton(signedIn).hover();
  await expect(signedIn.getByRole('tooltip')).toContainText('Sync failing');
  await expect(signedIn.getByRole('button', { name: /^Dismiss:/ })).toHaveCount(0);
});

/**
 * The reading is the last row of the column, and nothing widens the sidebar.
 *
 * The budget's own reading is always the bottom of the stack, so it is in the
 * same place whatever else the application has to say today, and a long alert
 * gives way rather than pushing the navigation wider. It is deliberately *not*
 * folded into Sync: Balanced / To delegate / Over-delegated is the reading the
 * household opens the application for, and it is nothing the bank feed did.
 *
 * The *ordering* between severities is proved in `notifications.test.ts`
 * instead. It cannot be staged here: the API reports the worst sync condition
 * rather than all of them, and it suppresses "not reporting" while a sync is
 * failing outright — both right, and between them there is no way to have two
 * severities on screen at once.
 */
test('the budget reading stays a tag in the sidebar, and nothing widens it', async ({
  signedIn,
}) => {
  await makeSyncFailure('connection refused');
  await signedIn.reload();

  const nav = signedIn.getByRole('navigation', { name: 'Main' });

  const stack = await nav.evaluate((node) =>
    /*
     * The tags, not the control that now describes itself with one too: Sync
     * carries `aria-describedby` for its folded panel, and it is the thing this
     * assertion is proving the column no longer contains.
     */
    Array.from(node.querySelectorAll('[role="status"], [aria-describedby]'))
      .filter((el) => el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'tooltip')
      .map((el) => {
        const box = el.getBoundingClientRect();
        return { text: (el.textContent ?? '').trim(), top: Math.round(box.top), right: box.right };
      }),
  );

  expect(stack.length).toBeGreaterThan(0);
  // Rendered order is top to bottom, so the array order is the reading order.
  const tops = stack.map((entry) => entry.top);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  expect(stack[stack.length - 1]!.text).toMatch(/Balanced|To delegate|Over-delegated/);

  const box = (await nav.boundingBox())!;
  for (const entry of stack) {
    expect(entry.right).toBeLessThanOrEqual(box.x + box.width);
  }
});
