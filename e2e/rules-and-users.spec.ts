import { expect, makeAccount, makeDelegation, test } from './fixtures.js';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Settings → Rules and Settings → Users.
 *
 * Rules move envelope balances across hundreds of rows at once, so the two
 * things worth guarding are the order they fire in — first match wins, and the
 * owner has to be able to tell which rule did what — and the promise that a bulk
 * apply never quietly overwrites a categorization made by hand.
 */

async function makeTransaction(
  api: APIRequestContext,
  accountId: string,
  amountCents: string,
  description: string,
): Promise<void> {
  await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt: '2026-08-05T00:00:00Z' },
  });
}

/** Creates a rule through the dialog, which is the only route now. */
async function makeRule(page: Page, text: string, delegation: string): Promise<void> {
  await page.getByRole('button', { name: 'New rule' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create an auto-categorization rule' });
  await dialog.getByLabel('This text').fill(text);
  await dialog.getByLabel('Categorize as').selectOption({ label: delegation });
  await dialog.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(`Description contains “${text}”`)).toBeVisible();
}

test('a rule is created and shown in the order it fires', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');

  await signedIn.goto('/settings/rules');
  await makeRule(signedIn, 'whole foods', 'Grocery');

  // The delegation it categorizes as is a column of its own now, so it reads as
  // a name rather than as an arrow glued to the rule's description.
  await expect(signedIn.getByText('Grocery', { exact: true })).toBeVisible();
});

test('rules can be reordered, because the first match wins', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');

  await signedIn.goto('/settings/rules');
  await makeRule(signedIn, 'market', 'Grocery');
  await makeRule(signedIn, 'corner', 'Dining');

  // Promote the second rule; "Corner Market" then goes to Dining rather than
  // Grocery, which is the whole point of the ordering.
  await signedIn.getByRole('button', { name: 'Move corner up' }).click();

  const rows = signedIn.getByText(/^Description contains/);
  await expect(rows.first()).toHaveText('Description contains “corner”');
});

test('the preview counts before anything moves, and leaves hand-made work alone', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');
  await makeTransaction(api, accountId, '-900', 'Unmatched thing');

  await signedIn.goto('/settings/rules');
  await makeRule(signedIn, 'whole foods', 'Grocery');

  // "1 of 423" and "397 of 423" are different decisions, so the number is
  // fetched when the dialog opens and nothing has moved yet.
  await signedIn.getByRole('button', { name: 'Run rules' }).click();
  await expect(signedIn.getByText('1 of 2 transactions would be categorized.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Cancel' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('applying the rules categorizes the backlog', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await makeDelegation(api, 'Grocery');
  await makeTransaction(api, accountId, '-4210', 'Whole Foods Market');

  await signedIn.goto('/settings/rules');
  await makeRule(signedIn, 'whole foods', 'Grocery');

  await signedIn.getByRole('button', { name: 'Run rules' }).click();
  const dialog = signedIn.getByRole('dialog', { name: /Run every enabled rule/ });
  await dialog.getByRole('button', { name: 'Run rules' }).click();
  await expect(signedIn.getByText('1 of 1 categorized.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('-$42.10');
});

test('overwriting hand-made categorizations is opt-in and warns first', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.goto('/settings/rules');
  await makeRule(signedIn, 'whole foods', 'Grocery');

  await signedIn.getByRole('button', { name: 'Run rules' }).click();

  const toggle = signedIn.getByRole('switch', {
    name: 'Also change transactions already categorized',
  });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(signedIn.getByRole('alert')).toContainText(
    'replace categorizations you made by hand',
  );
});

/** Creates an account through the dialog, which is the only route now. */
async function createAccount(page: Page, username: string): Promise<void> {
  await page.getByRole('button', { name: 'New person' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  await dialog.getByLabel('Username').fill(username);
  await dialog.getByLabel('Temporary password').fill('temporary-passphrase-here');
  await dialog.getByRole('button', { name: 'Save' }).click();

  // The dialog closing is the signal the write landed and the list refetched.
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/**
 * The household table, scoped.
 *
 * The activity card below it names the same accounts — an event is *about* an
 * account — so an unscoped `getByText` for a username matches both and resolves
 * strictly to neither. Two parts of one screen legitimately describing the same
 * person is the case this scoping exists for.
 */
function household(page: Page): Locator {
  return page.locator('section').filter({ hasText: 'The household' });
}

test('the first account is Super Admin and can create another', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  const table = household(signedIn);
  await expect(table.getByText('e2e-owner@example.test', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('Super Admin', { exact: true }).first()).toBeVisible();

  await createAccount(signedIn, 'second@example.test');

  await expect(table.getByText('second@example.test', { exact: true })).toBeVisible();
  // A temporary password reaches exactly one screen until it is changed.
  await expect(signedIn.getByText('Temporary password', { exact: true })).toBeVisible();
  // And a second factor is required of it before even that.
  await expect(signedIn.getByText('Not set up', { exact: true }).first()).toBeVisible();
});

/**
 * A display name, which anybody can set for themselves whatever role they hold.
 * The username is an email address and reads as one everywhere it appears.
 */
test('a display name replaces the username on screen', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  await signedIn.getByLabel('Display name').fill('Andy');
  await signedIn.getByRole('button', { name: 'Save' }).click();
  await expect(signedIn.getByText('Saved.')).toBeVisible();

  await signedIn.reload();
  await expect(signedIn.getByLabel('Display name')).toHaveValue('Andy');
  // Shown in the list, with the username kept underneath it.
  await expect(signedIn.getByText('Andy', { exact: true }).first()).toBeVisible();
});

test('an account can be archived and restored, but not your own', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');
  await createAccount(signedIn, 'second@example.test');
  await expect(household(signedIn).getByText('second@example.test', { exact: true })).toBeVisible();

  // Archiving yourself would lock the household out of its own budget, so the
  // item is not in your own menu at all.
  await signedIn.getByRole('button', { name: 'Options for e2e-owner@example.test' }).click();
  await expect(signedIn.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0);
  await signedIn.keyboard.press('Escape');

  await signedIn.getByRole('button', { name: 'Options for second@example.test' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(
    household(signedIn).locator('tbody tr').filter({ hasText: 'second@example.test' }),
  ).toContainText('Archived');

  await signedIn.getByRole('button', { name: 'Options for second@example.test' }).click();
  await signedIn.getByRole('menuitem', { name: 'Restore' }).click();
  // Back to whatever it was before, which for an account created a moment ago
  // is "Temporary password" rather than "Active".
  await expect(
    household(signedIn).locator('tbody tr').filter({ hasText: 'second@example.test' }),
  ).not.toContainText('Archived');
});

/**
 * The way back when the phone is gone and the recovery codes went with it.
 * Sign-in demands the second factor whenever one is confirmed, and no setting
 * anywhere changes that — so without this the only route is a database prompt.
 */
test('an administrator can reset somebody else’s second factor', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');

  const owner = household(signedIn)
    .locator('tbody tr')
    .filter({ hasText: 'e2e-owner@example.test' });
  await expect(owner.getByText('On', { exact: true })).toBeVisible();

  await signedIn.getByRole('button', { name: 'Options for e2e-owner@example.test' }).click();
  await signedIn.getByRole('menuitem', { name: 'Reset two-factor' }).click();

  /*
   * Either landing proves it, and which one you get is a race.
   *
   * The reset deletes that account's sessions. Your own may survive it, because
   * the very request that did the deleting writes its session back on the way
   * out — `rolling: true` refreshes the expiry on every response — and whether
   * that write lands before or after the delete commits is not ordered.
   *
   * So: signed out, or sent to enrolment. Both say the factor is gone, which is
   * the whole claim. Asserting on one of them is asserting on the race, and
   * this test failed exactly once that way under load before it said so.
   */
  await signedIn.reload();
  await expect(
    signedIn
      .getByRole('heading', { name: 'Set up two-factor authentication' })
      .or(signedIn.getByLabel('Username')),
  ).toBeVisible();
});

/**
 * The record of what happened to credentials.
 *
 * The screen is the whole point of this feature. An external review asked for
 * the table twice and it was declined twice on the grounds that a record nobody
 * reads is not a control — so what this asserts is that somebody arriving at
 * Settings → Users can see, without pressing anything, that a credential was
 * changed and who changed it.
 */
test('the activity card shows a credential change and names who made it', async ({ signedIn }) => {
  await signedIn.goto('/settings/users');
  await createAccount(signedIn, 'second@example.test');

  await signedIn.getByRole('button', { name: 'Options for second@example.test' }).click();
  await signedIn.getByRole('menuitem', { name: 'Reset password' }).click();

  const dialog = signedIn.getByRole('dialog', { name: /Reset the password/ });
  await dialog.getByLabel(/Temporary password for/).fill('another-temporary-phrase');
  await dialog.getByRole('button', { name: 'Reset password' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // Read straight off the card, unprompted — no filter, no search, no pager.
  const activity = signedIn
    .locator('section')
    .filter({ hasText: 'Sign-in activity' })
    .locator('tbody tr');

  await expect(activity.first()).toContainText('Password reset');
  await expect(activity.first()).toContainText('second@example.test');
  // Who did it, which is the line worth noticing on an administrator action.
  await expect(activity.first()).toContainText('by e2e-owner@example.test');
});

/**
 * The rule the table has to obey, asserted through the interface that shows it.
 * The login form has two fields, and a password typed into the top one must
 * never end up on a screen — or in the dump behind it.
 */
test('a password typed into the username box never reaches the activity card', async ({
  signedIn,
  browser,
}) => {
  const typed = 'correct-horse-battery-staple-in-the-wrong-box';

  /*
   * A context of its own, deliberately.
   *
   * `signedIn` *is* the `page` fixture with a session on it — asking that page
   * for `/login` gets a redirect to the budget, not a form. The failed attempt
   * has to come from a browser that is signed in as nobody, which is what this
   * whole test is about.
   */
  const stranger = await browser.newContext({ baseURL: signedIn.url() });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto('/login');
  await strangerPage.getByLabel('Username').fill(typed);
  await strangerPage.getByLabel('Password', { exact: true }).fill('whatever');
  await strangerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(strangerPage.getByText('Incorrect username or password.')).toBeVisible();
  await stranger.close();

  await signedIn.goto('/settings/users');
  const activity = signedIn.locator('section').filter({ hasText: 'Sign-in activity' });

  await expect(activity.locator('tbody tr').first()).toContainText('Wrong password');
  await expect(activity).not.toContainText(typed);
  await expect(activity.locator('tbody tr').first()).toContainText('unknown:');
});
