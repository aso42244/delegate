import { expect, test } from './fixtures.js';

/**
 * Where a person lands, and the navigation around it.
 *
 * `/` was the Budget page's own address, which is exactly why a landing
 * preference could not have worked before: a preference can only ever redirect
 * *away* from a root that is already something. Budget has its own address now
 * and the root resolves to whichever page this person chose.
 *
 * The property worth guarding is that null and the default are different
 * things. The column stores no default, so "never chose" stays distinguishable
 * from "chose Overview" — which is what lets the default move later without
 * overriding a decision somebody made.
 */

test('the root resolves to Overview for somebody who never chose', async ({ signedIn }) => {
  await signedIn.goto('/');

  await expect(signedIn).toHaveURL(/\/overview$/);
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a person who chooses Budget lands there, and it survives a reload', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  // Beside the display name, because both are yours to set whatever role you
  // hold and neither is a credential.
  await signedIn.getByLabel('Start on').selectOption('budget');
  /*
   * The write has to land before anything navigates. It saves on change, like
   * the cadence on Settings → Budget, so there is no button press to wait on —
   * the confirmation is the thing to assert, which is this suite's own rule
   * about acting after a write.
   */
  await expect(signedIn.getByText('Saved.')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn).toHaveURL(/\/budget$/);
  await expect(signedIn.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();

  /*
   * It is a fact about the person, not about the browser they are sitting at —
   * so it is stored on the account rather than per device, and a reload cannot
   * lose it.
   */
  await signedIn.reload();
  await expect(signedIn).toHaveURL(/\/budget$/);

  // And back again, which is the half that proves the control works both ways.
  await signedIn.goto('/settings/users');
  await signedIn.getByLabel('Start on').selectOption('overview');
  await expect(signedIn.getByText('Saved.')).toBeVisible();
  await signedIn.goto('/');
  await expect(signedIn).toHaveURL(/\/overview$/);
});

test('the sidebar leads with Overview and then Budget', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  /*
   * Overview is the daily read and Budget is where the work happens — a quick
   * review, then the full inspection — and the order is the order they are used
   * in. Asserted as an order rather than as two presences, because "both exist"
   * passes just as happily when they are the wrong way round.
   */
  const nav = signedIn.getByRole('navigation');
  const labels = await nav.getByRole('link').allInnerTexts();
  const trimmed = labels.map((label) => label.trim()).filter((label) => label !== '');

  expect(trimmed.slice(0, 2)).toEqual(['Overview', 'Budget']);
  expect(trimmed).not.toContain('Insights');
  expect(trimmed).not.toContain('Bills');
  expect(trimmed).not.toContain('Utilities');
});

test('the pages Overview replaced still answer to their old addresses', async ({ signedIn }) => {
  // A bookmark is a promise. Each of these still exists, in better form.
  await signedIn.goto('/insights');
  await expect(signedIn).toHaveURL(/\/overview$/);
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
