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
 * The reading is a control now, not the last row of a column.
 *
 * Balanced / To delegate / Over-delegated was the bottom tag of the alert stack.
 * It is the top of the **control zone** — always coloured, always a link to
 * Overview — while everything under it stays plain unless it has something to
 * report. That is what makes the corner of the screen answer one question at a
 * glance (ADR 064).
 *
 * The *ordering* between notification severities is proved in
 * `notifications.test.ts` instead. It cannot be staged here: the API reports the
 * worst sync condition rather than all of them, and it suppresses "not
 * reporting" while a sync is failing outright — both right, and between them
 * there is no way to have two severities on screen at once.
 */
test('the reading sits above Delegate, is coloured, and goes to Overview', async ({ signedIn }) => {
  await makeSyncFailure('connection refused');
  await signedIn.goto('/budget');

  const nav = signedIn.getByRole('navigation', { name: 'Main' });
  const reading = nav.getByRole('link', { name: /Balanced|To delegate|Over-delegated/ });
  await expect(reading).toBeVisible();

  // Coloured, and the only one in the zone that is: a failing sync paints Sync
  // itself, but Delegate and Sign out stay plain.
  await expect(reading).toHaveClass(/bg-(positive|accent|danger)-soft/);
  await expect(nav.getByRole('button', { name: 'Delegate' })).toHaveClass(/bg-canvas/);
  await expect(nav.getByRole('button', { name: 'Sign out' })).toHaveClass(/bg-canvas/);

  // Directly above Delegate, and above Sync and Sign out under that.
  const order = await Promise.all(
    [
      reading,
      nav.getByRole('button', { name: 'Delegate' }),
      nav.getByRole('button', { name: /Sync SimpleFIN/ }),
      nav.getByRole('button', { name: 'Sign out' }),
    ].map(async (control) => Math.round((await control.boundingBox())!.y)),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // Nothing separates Sign out from the button above it any more, and the
  // signed-in address and role are gone — both live in Settings.
  await expect(nav.getByText('e2e-owner@example.test')).toHaveCount(0);
  await expect(nav.getByText('Super Admin')).toHaveCount(0);

  // The working is still one hover away.
  await reading.hover();
  await expect(signedIn.getByRole('tooltip')).toContainText('Assets');

  // And it goes to Overview whatever it currently says.
  await reading.click();
  await expect(signedIn).toHaveURL(/\/overview/);
});
