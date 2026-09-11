import { expect, makeAccount, makeDelegation, openNew, test } from './fixtures.js';

/**
 * One way to make a thing.
 *
 * Seven create buttons over five screens became one control in every page
 * header. The property worth guarding is the one that made it worth doing: the
 * page somebody is on is no longer part of the question.
 */

test('is on every page, and always leftmost', async ({ signedIn }) => {
  for (const path of ['/overview', '/budget', '/transactions', '/recurring', '/settings/rules']) {
    await signedIn.goto(path);
    await expect(signedIn.getByRole('button', { name: 'New …' })).toBeVisible();
  }

  /*
   * Leftmost of the actions, so it holds the same position whatever else a page
   * puts beside it. Overview is the page with the most to put there now that
   * Delegate has moved to the sidebar: the window picker and Arrange.
   */
  await signedIn.goto('/overview');
  // Asserted by position rather than by DOM order, because "leftmost" is a fact
  // about the screen — and it is what somebody reaches for without looking.
  const New = await signedIn.getByRole('button', { name: 'New …' }).boundingBox();
  const arrange = await signedIn.getByRole('button', { name: 'Arrange' }).boundingBox();
  expect(New!.x).toBeLessThan(arrange!.x);
  // On the same row, not above it.
  expect(Math.abs(New!.y - arrange!.y)).toBeLessThan(New!.height);
});

test('makes a delegation from a page that is not Budget', async ({ signedIn }) => {
  await signedIn.goto('/transactions');

  /*
   * The whole point. A delegation used to be made by an inline input on Budget,
   * so making one meant knowing that delegations are made on Budget.
   */
  await openNew(signedIn, 'Delegation');
  const dialog = signedIn.getByRole('dialog', { name: 'New delegation' });
  await dialog.getByLabel('Name').fill('Vet');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // Ungrouped at the end, which is where the inline control on Budget always
  // put one.
  await signedIn.goto('/budget');
  await expect(signedIn.getByRole('button', { name: 'Options for Vet' })).toBeVisible();
});

test('makes a rule from a page that is not Settings', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Groceries');
  await signedIn.goto('/overview');

  /*
   * That the menu reaches the dialog from a page that is not Settings is the
   * property here. Writing the rule itself is `rules-and-users.spec.ts`, which
   * now opens the same dialog through the same menu — asserting it twice would
   * be two tests of one thing.
   */
  await openNew(signedIn, 'Rule');
  const dialog = signedIn.getByRole('dialog');
  await expect(dialog.getByLabel('This text')).toBeVisible();
  await expect(dialog.getByLabel('When the description')).toBeVisible();
});

test('no page carries a create button of its own', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 500_00n);
  await makeDelegation(api, 'Groceries');

  /*
   * Two routes to one action are how "Add grouping" and "New grouping" came to
   * exist on two screens. The menu is the route; a page-local button beside it
   * would be the second.
   */
  for (const path of ['/budget', '/transactions', '/settings/rules', '/settings/groupings']) {
    await signedIn.goto(path);
    await expect(
      signedIn.getByRole('button', { name: /^New (transaction|check|grouping|rule)$/ }),
    ).toHaveCount(0);
  }

  // What a page keeps is what is not creating a thing. Delegate is no longer one
  // of them: it is an act on the household and it lives in the sidebar, above
  // Sync, on every screen rather than on the one page it used to belong to.
  await signedIn.goto('/budget');
  await expect(signedIn.getByRole('button', { name: 'Delegate', exact: true })).toBeVisible();
  await signedIn.goto('/transactions');
  await expect(signedIn.getByRole('button', { name: 'Delegate', exact: true })).toBeVisible();
  await signedIn.goto('/settings/rules');
  await expect(signedIn.getByRole('button', { name: 'Run rules' })).toBeVisible();
});

test('closes on Escape and on a press outside it', async ({ signedIn }) => {
  await signedIn.goto('/overview');

  await signedIn.getByRole('button', { name: 'New …' }).click();
  await expect(signedIn.getByRole('menu', { name: 'Create' })).toBeVisible();
  await signedIn.keyboard.press('Escape');
  await expect(signedIn.getByRole('menu', { name: 'Create' })).toHaveCount(0);

  await signedIn.getByRole('button', { name: 'New …' }).click();
  await expect(signedIn.getByRole('menu', { name: 'Create' })).toBeVisible();
  await signedIn.getByRole('heading', { name: 'Overview' }).click();
  await expect(signedIn.getByRole('menu', { name: 'Create' })).toHaveCount(0);
});
