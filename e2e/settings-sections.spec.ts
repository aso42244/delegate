import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Settings → Delegations, Groupings and Archived.
 *
 * The behaviour worth protecting is that archiving is a refusal rather than a
 * silent success when it would break something, and that an archived row can be
 * found and brought back — the whole point of never hard-deleting anything.
 */

/**
 * The register's size, where it went when it left the Transactions header.
 *
 * It counted the whole register — a fact about how long the household has been
 * running rather than anything the page it sat on is for.
 */
test('the transaction count is on Sync, not on the Transactions page', async ({
  signedIn: page,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  for (const [amountCents, description] of [
    ['-4210', 'Whole Foods Market'],
    ['-1500', 'Corner Shop'],
  ] as const) {
    await api.post('/api/transactions', {
      data: { accountId, amountCents, description, postedAt: '2026-08-05T00:00:00Z' },
    });
  }

  await page.goto('/transactions');
  await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();
  await expect(page.getByText(/transactions?\./)).toHaveCount(0);

  await page.goto('/settings/sync');
  await expect(page.getByText('2 transactions in the register.')).toBeVisible();
});

test('a delegation is edited from Settings and the Budget agrees', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  // Delegations live on the Budget tab now, beside the budget's own settings —
  // which have a Save button of their own, so this one is reached through the
  // table it belongs to rather than by name alone.
  await signedIn.goto('/settings/delegations');
  await expect(signedIn).toHaveURL(/\/settings\/budget$/);
  await signedIn.getByRole('button', { name: /Grocery/ }).click();

  await signedIn.getByLabel('Name of Grocery').fill('Groceries');
  await signedIn.getByLabel('Amount to delegate for Grocery').fill('250.00');
  await signedIn.getByLabel('Note for Grocery').fill('Weekly shop');
  await signedIn.getByRole('table').getByRole('button', { name: 'Save' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Groceries balance' })).toBeVisible();
  await expect(
    signedIn.getByRole('button', { name: 'Groceries amount to delegate' }),
  ).toContainText('$250.00');
});

/**
 * Null is not zero. An emptied amount means "add nothing when Delegate is
 * pressed" and shows an em-dash; a typed zero is a deliberate zero.
 */
test('clearing the amount makes a line ad hoc rather than zero', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery', '25000');

  await signedIn.goto('/settings/delegations');
  await signedIn.getByRole('button', { name: /Grocery/ }).click();
  await signedIn.getByLabel('Amount to delegate for Grocery').fill('');
  await signedIn.getByRole('table').getByRole('button', { name: 'Save' }).click();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery amount to delegate' })).toContainText(
    '—',
  );
});

test('a grouping is created and renamed from Settings', async ({ signedIn }) => {
  await signedIn.goto('/settings/groupings');

  await signedIn.getByRole('button', { name: 'New grouping' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Create a grouping' });
  await dialog.getByLabel('Name').fill('Essentials');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  await signedIn.getByLabel('Name of Essentials').fill('Household costs');
  await signedIn.getByLabel('Name of Essentials').blur();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: /Household costs/ })).toBeVisible();
});

test('a grouping holding a live line refuses to archive', async ({ signedIn, api }) => {
  await signedIn.goto('/settings/groupings');
  await signedIn.getByRole('button', { name: 'New grouping' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Create a grouping' });
  await dialog.getByLabel('Name').fill('Essentials');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);
  await expect(signedIn.getByLabel('Name of Essentials')).toBeVisible();

  // Put a delegation inside it, then try to archive the grouping.
  const delegationId = await makeDelegation(api, 'Grocery');
  const budget = await (await api.get('/api/budget')).json();
  const groupingId = (budget as { delegations: { groupings: { id: string }[] } }).delegations
    .groupings[0]?.id;
  await api.patch(`/api/delegations/${delegationId}`, { data: { groupingId } });

  await signedIn.goto('/settings/groupings');
  await signedIn.getByRole('button', { name: 'Archive Essentials' }).click();

  // Archiving it would orphan the line inside it.
  await expect(signedIn.getByRole('alert')).toContainText('live item');
});

test('an archived delegation is listed and can be restored', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/delegations');
  await signedIn.getByRole('button', { name: /Grocery/ }).click();
  await signedIn.getByRole('button', { name: 'Archive Grocery' }).click();

  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByText('Grocery')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Restore Grocery' }).click();
  await expect(signedIn.getByText('Nothing is archived.')).toBeVisible();

  // Back on the budget, where it was before.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toBeVisible();
});

test('an archived account is listed beside archived delegations', async ({ signedIn }) => {
  await makeAccount('Old Card', 'debt', 0n);

  await signedIn.goto('/settings/accounts');
  await signedIn.getByRole('button', { name: 'Options for Old Card' }).click();
  await signedIn.getByRole('menuitem', { name: 'Archive' }).click();

  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByRole('button', { name: 'Restore Old Card' })).toBeVisible();
});

test('Archived says so plainly when there is nothing in it', async ({ signedIn }) => {
  await signedIn.goto('/settings/archived');
  await expect(signedIn.getByText('Nothing is archived.')).toBeVisible();
});

/**
 * Twelve tabs became eight, and half of the twelve held a single card. A tab row
 * that long is a list of words to read rather than a set of places to go.
 */
test('the sections are seven, and every old route still lands somewhere', async ({ signedIn }) => {
  await signedIn.goto('/settings/sync');

  // Seven since Rules left for the sidebar: a rule is written while
  // categorizing and read when a charge lands somewhere surprising, which is
  // the register's rhythm rather than a thing configured once.
  const tabs = signedIn.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link')).toHaveCount(7);

  // A section that moves is a bookmark that breaks, a link in somebody's notes
  // that breaks, and a test that fails for a reason unrelated to what it tests.
  for (const [was, now] of [
    ['delegations', 'budget'],
    ['groupings', 'budget'],
    ['bitcoin', 'holdings'],
    ['properties', 'holdings'],
    ['users', 'access'],
    ['tor', 'access'],
    ['security', 'access'],
  ]) {
    await signedIn.goto(`/settings/${was}`);
    await expect(signedIn).toHaveURL(new RegExp(`/settings/${now}$`));
  }

  // Rules left Settings entirely, so its old path lands outside it.
  await signedIn.goto('/settings/rules');
  await expect(signedIn).toHaveURL(/\/rules$/);
});

test('the section list can move to a rail beside the sidebar', async ({ signedIn }) => {
  await signedIn.goto('/settings/display');

  // A row above the cards to begin with, which is where it has always been.
  const tabs = signedIn.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs).toBeVisible();
  const across = await tabs.boundingBox();

  await signedIn.getByRole('radio', { name: 'Down the side' }).click();

  // The same list, now taller than it is wide. Asserting on the shape rather
  // than on a class: what changed is where it sits, and a class name is one
  // refactor away from saying nothing.
  await expect(tabs).toBeVisible();
  const down = await tabs.boundingBox();
  expect(across!.width).toBeGreaterThan(across!.height);
  expect(down!.height).toBeGreaterThan(down!.width);

  // And it is remembered, because it is a preference about this device.
  await signedIn.reload();
  const still = await signedIn.getByRole('navigation', { name: 'Settings sections' }).boundingBox();
  expect(still!.height).toBeGreaterThan(still!.width);
});

/**
 * A card that holds three radio buttons has no business taking the width of one
 * that holds a table of forty rules.
 */
test('cards that are small enough share a row', async ({ signedIn }) => {
  await signedIn.goto('/settings/display');

  const theme = await signedIn
    .getByText('Six palettes, or whatever this device asks for.')
    .boundingBox();
  const rows = await signedIn
    .getByText('Spacing only — the text stays the same size.')
    .boundingBox();

  // Side by side: same line, different columns.
  expect(Math.abs(theme!.y - rows!.y)).toBeLessThan(4);
  expect(rows!.x).toBeGreaterThan(theme!.x);
});

/**
 * A card's content stays inside the card.
 *
 * The backups table drew its columns past its own border on a wide screen: it
 * asked `sm:` how wide the *window* was, got 1440, and laid itself out for a
 * card that was actually 345px across. Cards are query containers now, and this
 * is the assertion that says so — measured, because the failure was invisible to
 * every test that only looked for text.
 */
test('cards on one row sit side by side and keep their tables inside them', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });
  await signedIn.setViewportSize({ width: 1440, height: 900 });
  await signedIn.goto('/settings/budget');

  const delegations = signedIn.locator('section', { has: signedIn.getByText('Every envelope') });
  const groupings = signedIn.locator('section', {
    has: signedIn.getByText('a grouping has no balance of its own'),
  });

  const left = await delegations.boundingBox();
  const right = await groupings.boundingBox();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();

  // Side by side: level with each other, and one starts where the other ends.
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 2);
  // And level at the bottom, which is what `h-full` on the card is for.
  expect(Math.abs(left!.height - right!.height)).toBeLessThan(2);

  for (const card of [delegations, groupings]) {
    const box = (await card.boundingBox())!;
    const table = (await card.getByRole('table').boundingBox())!;
    expect(table.x + table.width).toBeLessThanOrEqual(box.x + box.width);
  }
});
