import { expect, makeDelegation, test } from './fixtures.js';

/**
 * Targets.
 *
 * One promise carries this whole feature and every test here is a way of
 * checking it: **a target never moves the amount to delegate.** That figure is
 * the household's decision, typed by hand every payday, and an application that
 * quietly rewrote it would be moving real money on the next Delegate press for a
 * reason nobody asked for.
 *
 * The arithmetic itself is proved in `packages/shared`; what a browser has to
 * show is that the reading appears, that it is explained where somebody is
 * deciding, and that taking it is a separate, deliberate press.
 */

/** A date far enough out that the fixtures do not go stale on the calendar. */
function nextYear(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

test('a target is set, and changes nothing about what gets delegated', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Car Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();

  await signedIn.getByLabel('Target amount').fill('2200.00');
  await signedIn.getByLabel('By').fill(nextYear());

  // The reading, live, before anything is saved — and the comparison stated in
  // both directions, so neither figure has to be remembered.
  await expect(signedIn.getByText(/Needs .* a paycheck/)).toBeVisible();
  await expect(signedIn.getByText('This line is set to delegate $100.00.')).toBeVisible();
  await expect(
    signedIn.getByText(
      'A target changes nothing on its own. It works out what each paycheck needs to carry and marks the amount when it is not enough.',
    ),
  ).toBeVisible();

  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // The promise: untouched.
  await expect(
    signedIn.getByRole('button', { name: 'Car Insurance amount to delegate' }),
  ).toContainText('$100.00');
});

test('the amount to delegate is marked when it will not make the date', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Car Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();
  // $5,000 over a year is roughly $192 a paycheck, which $100 does not reach.
  await signedIn.getByLabel('Target amount').fill('5000.00');
  await signedIn.getByLabel('By').fill(nextYear());
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  /*
   * The sentence sits on the figure that is wrong rather than beside the name.
   * The amount to delegate is what decides whether the target is reached, so it
   * is the number to change — and `aria-describedby` puts the reason within
   * reach of somebody who never hovers anything.
   */
  const cell = signedIn.getByRole('button', { name: 'Car Insurance amount to delegate' });
  await expect(cell).toHaveAttribute('title', /more than this line is set to delegate/);

  // And the pill, for somebody who is not looking at that row.
  await expect(signedIn.getByRole('link', { name: /1 line behind/ })).toBeVisible();
});

test('the needed amount can be taken, in one deliberate press', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Car Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();
  await signedIn.getByLabel('Target amount').fill('2600.00');
  // Twenty-six fortnights: $100 a paycheck exactly, which makes the assertion
  // about the figure rather than about the arithmetic.
  await signedIn.getByLabel('By').fill(nextYear());

  await signedIn.getByRole('switch', { name: /Also set the amount to delegate/ }).click();
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // It moved because somebody turned a switch on, and it is an ordinary amount
  // afterwards — typed over, cleared, or left alone like any other.
  await expect(
    signedIn.getByRole('button', { name: 'Car Insurance amount to delegate' }),
  ).toContainText('$100.00');
  await expect(signedIn.getByRole('link', { name: /line behind/ })).toHaveCount(0);
});

/**
 * The one the owner entered first: home insurance, due on the last day of April
 * and again on the last day of October. A single date records the April one and
 * then goes stale the moment it passes — leaving the same target to be retyped
 * twice a year, which is the arithmetic targets exist to stop doing by hand.
 */
test('a target can repeat, and works towards the next one', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Home Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Home Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();

  await signedIn.getByLabel('Target amount').fill('2200.00');
  // An occurrence in the past, deliberately: the date is an anchor for the
  // series rather than a deadline, and the reading has to move past it.
  await signedIn.getByLabel('By').fill('2020-04-30');
  await signedIn.getByLabel('Repeats').selectOption({ label: 'Every 6 months' });

  // The end of the month is kept: the last day of April recurs on the last day
  // of October, which is not the 30th of it.
  await expect(signedIn.getByText(/Next: (Apr 30|Oct 31)/)).toBeVisible();

  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(
    signedIn.getByRole('button', { name: 'Home Insurance amount to delegate' }),
  ).toHaveAttribute('title', /every 6 months/);
});

test('the calculated amount can be taken, or changed on the way past', async ({
  signedIn,
  api,
}) => {
  await makeDelegation(api, 'Home Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Home Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();
  await signedIn.getByLabel('Target amount').fill('2600.00');
  await signedIn.getByLabel('By').fill(nextYear());

  await signedIn.getByRole('switch', { name: 'Also set the amount to delegate' }).click();

  // Pre-filled with what was worked out, and editable — the calculated figure
  // is the common answer rather than the only one, and rounding it up to
  // something memorable should not mean closing this and typing on the row.
  const field = signedIn.getByRole('textbox', { name: 'Amount to delegate' });
  await expect(field).toHaveValue('100.00');
  await field.fill('150.00');

  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(
    signedIn.getByRole('button', { name: 'Home Insurance amount to delegate' }),
  ).toContainText('$150.00');
});

test('a target is removed from the same dialog', async ({ signedIn, api }) => {
  await makeDelegation(api, 'Car Insurance', '10000');
  await signedIn.goto('/');

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a target' }).click();
  await signedIn.getByLabel('Target amount').fill('500.00');
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // A standing target: an amount to keep here, with no date to work to.
  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await expect(signedIn.getByRole('menuitem', { name: /Edit the target/ })).toBeVisible();
  await signedIn.getByRole('menuitem', { name: /Edit the target/ }).click();
  await expect(signedIn.getByText(/short. With no date/)).toBeVisible();

  await signedIn.getByRole('button', { name: 'Remove' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await signedIn.getByRole('button', { name: 'Options for Car Insurance' }).click();
  await expect(signedIn.getByRole('menuitem', { name: /Set a target/ })).toBeVisible();
});
