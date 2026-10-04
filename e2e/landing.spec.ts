import { expect, test } from './fixtures.js';

/**
 * Where a person lands, and the navigation around it.
 *
 * `/` is a redirect rather than a page. Overview is the only place left to land:
 * the Budget page was deleted when ADR 067's trial ended, and a stored choice of
 * it lands on Overview.
 */

test('the root resolves to Overview for somebody who never chose', async ({ signedIn }) => {
  await signedIn.goto('/');

  await expect(signedIn).toHaveURL(/\/overview$/);
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a stored choice of Budget lands on Overview', async ({ signedIn, api }) => {
  /*
   * The Budget page was deleted when ADR 067's trial ended. Anybody who had
   * chosen it keeps that choice in the database — it is a decision somebody
   * made — and lands where its tables now live.
   */
  const response = await api.patch('/api/auth/me', {
    data: { landingPage: 'budget' },
  });
  expect(response.ok()).toBe(true);

  await signedIn.goto('/');
  await expect(signedIn).toHaveURL(/\/overview$/);
  await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('the sidebar leads with Overview, and Budget is not in it', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  /*
   * Overview leads, and is the only one of the two: the Budget page was
   * deleted when ADR 067's trial ended.
   *
   * Asserted as a position rather than a presence: "Overview is somewhere in the
   * list" passes just as happily when it is last.
   */
  const nav = signedIn.getByRole('navigation');
  // `allInnerTexts` does not wait, so read the list only once it is drawn —
  // read on arrival it can be empty, and an empty list has no first entry.
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible();
  const labels = await nav.getByRole('link').allInnerTexts();
  const trimmed = labels.map((label) => label.trim()).filter((label) => label !== '');

  expect(trimmed[0]).toBe('Overview');
  expect(trimmed).not.toContain('Budget');
  expect(trimmed).not.toContain('Insights');
  expect(trimmed).not.toContain('Bills');
  expect(trimmed).not.toContain('Utilities');
});

test('the pages Overview replaced still answer to their old addresses', async ({ signedIn }) => {
  // A bookmark is a promise. Each of these still exists, in better form.
  for (const path of ['/insights', '/budget']) {
    await signedIn.goto(path);
    await expect(signedIn).toHaveURL(/\/overview$/);
    await expect(signedIn.getByRole('heading', { name: 'Overview' })).toBeVisible();
  }
});
