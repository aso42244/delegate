import type { Locator } from '@playwright/test';
import { expect, makeAccount, makeDelegation, makePendingSpend, test } from './fixtures.js';

/**
 * The Budget page, driven in a real browser.
 *
 * These cover what unit and integration tests structurally cannot: that the page
 * boots, that an edit reaches the server and comes back changed, and that the
 * headline figure agrees with the rows beneath it after every operation.
 */

test('signing in reaches the budget', async ({ signedIn }) => {
  await expect(signedIn.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();
  await expect(signedIn.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('an empty budget reads as balanced', async ({ signedIn }) => {
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
});

test('money that has landed reads as available to delegate, not as a fault', async ({
  signedIn,
}) => {
  await makeAccount('Everyday Checking', 'asset', 489000n);
  await signedIn.reload();

  // The ordinary payday state. It must not be styled as a warning.
  const banner = signedIn.getByRole('status');
  await expect(banner).toContainText('$4,890.00 to delegate');
  await expect(banner).not.toContainText('over-delegated');
});

/**
 * The reason the totals are rows of the table rather than a heading above it.
 * Laid out separately they have to be kept in step by hand, and drift is
 * invisible until someone reads a column of figures that does not add up to the
 * number on top of it.
 */
test('a section total sits in the column it totals', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 1379665n);
  await makeDelegation(api, 'Grocery', '40000');
  await signedIn.reload();

  const right = async (locator: Locator): Promise<number> => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('not rendered');
    return box.x + box.width;
  };

  const aligned = async (total: Locator, row: Locator): Promise<void> => {
    // Sub-pixel, because a column edge lands on a fraction at some zoom levels.
    expect(Math.abs((await right(total)) - (await right(row)))).toBeLessThanOrEqual(1);
  };

  const sectionOf = (heading: string): Locator =>
    signedIn
      .getByRole('table')
      .filter({ has: signedIn.getByRole('heading', { name: heading, exact: true }) });

  // Assets: one money column, so one total to place.
  await aligned(
    sectionOf('Assets').locator('thead .money'),
    signedIn.getByRole('button', { name: 'Everyday Checking balance' }),
  );

  // Delegations: two, including the quieter one on the right.
  const delegationTotals = sectionOf('Delegations').locator('thead .money');
  await aligned(delegationTotals.nth(0), signedIn.getByRole('button', { name: 'Grocery balance' }));
  await aligned(
    delegationTotals.nth(1),
    signedIn.getByRole('button', { name: 'Grocery amount to delegate' }),
  );
});

/**
 * Reported from real data: exactly balanced, then a card charge went pending.
 * Categorizing it emptied the envelope while the card's reported balance stayed
 * put, and the page offered that money to delegate a second time.
 */
test('a pending charge is not offered as money to delegate', async ({ signedIn, api }) => {
  await makeAccount('Frontier Checking', 'asset', 100_000n);
  const card = await makeAccount('Costco Citi VISA', 'debt', 0n, 'simplefin');
  const grocery = await makeDelegation(api, 'Grocery');

  await signedIn.reload();
  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const balance = signedIn.getByLabel('Grocery balance');
  await balance.fill('1000.00');
  await balance.press('Enter');
  await expect(signedIn.getByRole('status')).toContainText('Balanced');

  // No term at all while nothing is pending — it would be four words of noise on
  // the one line that has to be read at a glance.
  await expect(signedIn.getByRole('status')).not.toContainText('Pending');

  await makePendingSpend(card, grocery, -36_147n);
  await signedIn.reload();

  const banner = signedIn.getByRole('status');
  await expect(banner).toContainText('Balanced');
  await expect(banner).toContainText('− Pending $361.47');
});

test('a delegation is created by typing a name and pressing Enter', async ({ signedIn }) => {
  const field = signedIn.getByLabel('Add to Delegations');
  await field.fill('Grocery');
  await field.press('Enter');

  // Typing sixty of these by hand is the go-live path, so a name has to be enough.
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
});

test('editing a balance records the difference and updates the identity', async ({
  signedIn,
  api,
}) => {
  await makeAccount('Everyday Checking', 'asset', 100000n);
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('650.00');
  await input.press('Enter');

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$650.00');
  // Assets 1000 − Delegations 650 = 350 still to delegate.
  await expect(signedIn.getByRole('status')).toContainText('$350.00 to delegate');
});

test('an unparseable amount is kept on screen rather than discarded', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('not a number');
  await input.press('Enter');

  // Silently dropping what someone typed is how a mistyped amount becomes an
  // unnoticed wrong number.
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('not a number');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('Escape abandons an edit', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('999.00');
  await input.press('Escape');

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
});

test('an ad-hoc line shows an em-dash rather than zero', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Occasional', null);
  await signedIn.reload();

  // Null means "adds nothing when Delegate is pressed", which reads differently
  // from a deliberate $0.
  await expect(signedIn.getByRole('button', { name: 'Occasional amount to delegate' })).toHaveText(
    '—',
  );
});

test('Delegate previews, distributes, and can be undone', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 30000n);
  await makeDelegation(api, 'Grocery', '20000');
  await makeDelegation(api, 'Power', '10000');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Delegate', exact: true }).click();

  const dialog = signedIn.getByRole('dialog', { name: 'Confirm delegate' });
  await expect(dialog).toContainText('$300.00');
  await expect(dialog).toContainText('2 lines');

  await dialog.getByRole('button', { name: 'Delegate', exact: true }).click();

  // Distributed: the identity lands on balanced.
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$200.00');

  // The undo offer states the cycle rollback, so it is not a surprise.
  await expect(signedIn.getByText('Undoing also rolls the budget cycle back.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Undo' }).click();

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$0.00');
  await expect(signedIn.getByRole('status')).toContainText('$300.00 to delegate');
});

test('Transfer moves between envelopes without moving the bottom line', async ({
  signedIn,
  api,
}) => {
  await makeAccount('Everyday Checking', 'asset', 30000n);
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Dining');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const balance = signedIn.getByLabel('Grocery balance');
  await balance.fill('300.00');
  await balance.press('Enter');
  await expect(signedIn.getByRole('status')).toContainText('Balanced');

  await signedIn.getByRole('button', { name: 'Transfer' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Transfer between delegations' });
  // The balance is part of the option label now, so choosing where to move
  // money from means comparing what the candidates hold while the list is open.
  await dialog.getByLabel('From').selectOption({ label: 'Grocery — $300.00' });
  await dialog.getByLabel('To').selectOption({ label: 'Dining — $0.00' });
  await dialog.getByLabel('Amount').fill('100.00');
  await dialog.getByRole('button', { name: 'Transfer' }).click();

  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$200.00');
  await expect(signedIn.getByRole('button', { name: 'Dining balance' })).toContainText('$100.00');
  // Envelope-to-envelope movement nets to zero across the delegations total.
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
});

test('a negative delegation balance is the only red in the table', async ({ signedIn, api }) => {
  await makeAccount('Card', 'debt', 54321n);
  await makeDelegation(api, 'Grocery');
  await signedIn.reload();

  await signedIn.getByRole('button', { name: 'Grocery balance' }).click();
  const input = signedIn.getByLabel('Grocery balance');
  await input.fill('-25.00');
  await input.press('Enter');

  const negative = signedIn.getByRole('button', { name: 'Grocery balance' });
  await expect(negative).toHaveClass(/text-negative/);

  // Debts are liabilities but are never rendered red.
  await expect(signedIn.getByRole('button', { name: 'Card balance' })).not.toHaveClass(
    /text-negative/,
  );
});

test('the sidebar collapses and stays collapsed across a reload', async ({ signedIn }) => {
  await signedIn.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(signedIn.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

  await signedIn.reload();

  // Persisted per device, so it survives a refresh.
  await expect(signedIn.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});

/**
 * Collapsing a grouping moves rows, not money.
 *
 * It used to send the change, refetch the entire budget, and only then move
 * anything — one to two seconds of nothing happening, for a preference the
 * browser already knew the answer to. The cache is updated first now, which is
 * what makes the risk worth a test: an optimistic update that never reaches the
 * server looks perfect until the page is reloaded.
 */
test('a collapsed grouping folds at once and is still folded after a reload', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');
  await api.post('/api/groupings', { data: { name: 'Essentials', section: 'delegations' } });
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Grocery' }).click();
  await signedIn.getByRole('menuitem', { name: 'Move to grouping' }).click();
  await signedIn.getByRole('menuitem', { name: 'Essentials' }).click();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();

  // Scoped to the grouping's own row: the row menu still carries an "Essentials"
  // item, so the bare name matches more than one control.
  const toggle = signedIn
    .getByRole('row')
    .filter({ hasText: 'Essentials' })
    .getByRole('button')
    .first();

  await toggle.click();

  // Folded, and the row it was holding is gone from the table. The chevron is
  // the only thing that says so now, so the state is read from `aria-expanded`
  // rather than from prose that is no longer there.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeHidden();

  // And it actually reached the server, which the optimistic update would hide.
  await signedIn.reload();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeHidden();

  // Unfolding is the same trip in reverse.
  await signedIn
    .getByRole('row')
    .filter({ hasText: 'Essentials' })
    .getByRole('button')
    .first()
    .click();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();
  await signedIn.reload();
  await expect(signedIn.getByRole('cell', { name: 'Grocery', exact: true })).toBeVisible();
});

/**
 * The Transfer dropdowns mirror the page beneath them.
 *
 * This dialog is only ever opened while looking at the Budget page, so a flat
 * alphabetical list made finding a line in the dialog a different act from
 * finding it on the page.
 */
test('Transfer lists delegations grouped as the page groups them', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 30000n);

  const grouping = async (name: string): Promise<string> => {
    const created = await api.post('/api/groupings', {
      data: { name, section: 'delegations' },
    });
    return ((await created.json()) as { grouping: { id: string } }).grouping.id;
  };

  const essentials = await grouping('Essentials');
  const fun = await grouping('Discretionary');

  const grocery = await makeDelegation(api, 'Grocery');
  const dining = await makeDelegation(api, 'Dining');
  await makeDelegation(api, 'Odds and Ends');

  await api.patch(`/api/delegations/${grocery}`, { data: { groupingId: essentials } });
  await api.patch(`/api/delegations/${dining}`, { data: { groupingId: fun } });

  await signedIn.goto('/');
  await signedIn.getByRole('button', { name: 'Transfer' }).click();

  const from = signedIn
    .getByRole('dialog', { name: 'Transfer between delegations' })
    .getByLabel('From');

  // Grouped, and each option carries the balance it holds.
  await expect(from.locator('optgroup')).toHaveCount(2);
  await expect(from.locator('optgroup').nth(0)).toHaveAttribute('label', 'Discretionary');
  await expect(from.locator('optgroup').nth(1)).toHaveAttribute('label', 'Essentials');
  await expect(from.locator('optgroup[label="Essentials"] option')).toHaveText(['Grocery — $0.00']);

  // Ungrouped lines sit after the groupings, as they do on the page.
  await expect(from.locator('> option')).toHaveText([
    'Choose a delegation',
    'Odds and Ends — $0.00',
  ]);
});
