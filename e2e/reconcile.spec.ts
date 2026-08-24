import { expect, makeDelegation, test } from './fixtures.js';

/**
 * Settings → Reconcile, and Settings → Budget.
 *
 * Reconcile is the screen go-live depends on: a backfilled, categorized year
 * leaves every envelope deeply negative, and this is what corrects sixty of them
 * in one commit. The behaviour worth guarding hardest is that a blank line is
 * left alone — reading a blank as zero would silently empty every envelope the
 * owner had not reached yet.
 */

test('a blank line is left alone; only filled lines are corrected', async ({ signedIn, api }) => {
  const grocery = await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');
  // A categorized backfill leaves this far negative. That is the starting point
  // the screen exists for.
  await api.post(`/api/delegations/${grocery}/adjust`, { data: { deltaCents: '-900000' } });

  await signedIn.goto('/settings/reconcile');
  await expect(signedIn.getByText('A line left blank is not touched.')).toBeVisible();

  await signedIn.getByLabel('Actual balance for Grocery').fill('725.00');
  // Household is deliberately left blank.

  await expect(signedIn.getByText('1 line will change, moving +$9,725.00 in total.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Commit corrections' }).click();

  await expect(signedIn.getByRole('alert')).toContainText('1 line corrected in one commit');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$725.00');
  // Untouched, not zeroed.
  await expect(signedIn.getByRole('button', { name: 'Household balance' })).toContainText('$0.00');
});

test('several lines commit together and the totals agree', async ({ signedIn, api }) => {
  const grocery = await makeDelegation(api, 'Grocery');
  const household = await makeDelegation(api, 'Household');
  await api.post(`/api/delegations/${grocery}/adjust`, { data: { deltaCents: '-50000' } });
  await api.post(`/api/delegations/${household}/adjust`, { data: { deltaCents: '-20000' } });

  await signedIn.goto('/settings/reconcile');
  await signedIn.getByLabel('Actual balance for Grocery').fill('100.00');
  await signedIn.getByLabel('Actual balance for Household').fill('-50.00');

  await expect(signedIn.getByText('2 lines will change, moving +$750.00 in total.')).toBeVisible();
  await signedIn.getByRole('button', { name: 'Commit corrections' }).click();

  await expect(signedIn.getByRole('alert')).toContainText('2 lines corrected in one commit');

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Grocery balance' })).toContainText('$100.00');
  await expect(signedIn.getByRole('button', { name: 'Household balance' })).toContainText(
    '-$50.00',
  );
});

test('Enter moves down the column', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');
  await makeDelegation(api, 'Household');

  await signedIn.goto('/settings/reconcile');
  const first = signedIn.getByLabel('Actual balance for Grocery');
  await first.fill('10.00');
  await first.press('Enter');

  // Sixty lines is a typing session, so the keyboard has to carry it.
  await expect(signedIn.getByLabel('Actual balance for Household')).toBeFocused();
});

test('a line that already reads its actual is not a change', async ({ signedIn, api }) => {
  const grocery = await makeDelegation(api, 'Grocery');
  await api.post(`/api/delegations/${grocery}/adjust`, { data: { deltaCents: '72500' } });

  await signedIn.goto('/settings/reconcile');
  await signedIn.getByLabel('Actual balance for Grocery').fill('725.00');

  await expect(signedIn.getByText('Nothing to commit yet.')).toBeVisible();
  await expect(signedIn.getByRole('button', { name: 'Commit corrections' })).toBeDisabled();
});

test('a cell that is not an amount blocks the commit and says so', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/reconcile');
  await signedIn.getByLabel('Actual balance for Grocery').fill('seven hundred');

  await expect(signedIn.getByRole('alert')).toContainText('not a valid amount');
  await expect(signedIn.getByRole('button', { name: 'Commit corrections' })).toBeDisabled();
});

test('the first commit is recorded as go-live, and a later one does not move it', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Grocery');

  await signedIn.goto('/settings/reconcile');
  await expect(
    signedIn.getByText('This first commit will also be recorded as your go-live date.'),
  ).toBeVisible();

  await signedIn.getByLabel('Actual balance for Grocery').fill('725.00');
  await signedIn.getByRole('button', { name: 'Commit corrections' }).click();
  await expect(signedIn.getByRole('alert')).toContainText('corrected in one commit');

  await signedIn.goto('/settings/budget');
  await expect(signedIn.getByText(/Go-live was/)).toBeVisible();
  const stamped = await signedIn.getByText(/Go-live was/).textContent();

  // A later reconcile is ordinary maintenance and must not rewrite which history
  // counts as backfill.
  await signedIn.goto('/settings/reconcile');
  await expect(
    signedIn.getByText('This first commit will also be recorded as your go-live date.'),
  ).toHaveCount(0);
  await signedIn.getByLabel('Actual balance for Grocery').fill('800.00');
  await signedIn.getByRole('button', { name: 'Commit corrections' }).click();
  await expect(signedIn.getByRole('alert')).toContainText('corrected in one commit');

  await signedIn.goto('/settings/budget');
  await expect(signedIn.getByText(/Go-live was/)).toHaveText(stamped ?? '');
});

test('the tolerance is configurable and the banner follows it', async ({ signedIn, api }) => {
  const grocery = await makeDelegation(api, 'Grocery');
  // $7.40 over-delegated: a warning at the $5 default, balanced at $10.
  await api.post(`/api/delegations/${grocery}/adjust`, { data: { deltaCents: '740' } });

  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('Over delegated $7.40');

  await signedIn.goto('/settings/budget');
  const tolerance = signedIn.getByLabel('Tolerance');
  // The same race as below: the stored value has to land before it is typed over.
  await expect(tolerance).not.toHaveValue('');
  await tolerance.fill('10.00');
  await signedIn.getByRole('button', { name: 'Save' }).click();
  await expect(signedIn.getByText('Saved.')).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('status')).toContainText('Balanced');
});

test('the undo window is bounded, and the refusal explains why', async ({ signedIn }) => {
  await signedIn.goto('/settings/budget');

  // Wait for the stored value to land before typing over it. The field shows the
  // server's number until it is edited, so filling it while the query is still
  // in flight is a race the typist always wins locally and loses on slower
  // hardware — the load arrives second and puts 24 back.
  const field = signedIn.getByLabel('Undo window (hours)');
  await expect(field).not.toHaveValue('');

  await field.fill('0');
  await signedIn.getByRole('button', { name: 'Save' }).click();

  await expect(signedIn.getByRole('alert')).toContainText('between 1 hour and 168 hours');
});
