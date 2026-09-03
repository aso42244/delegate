import { expect, makeAccount, makeDelegation, test } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Bills.
 *
 * Everything on this page is worked out from the register, so the fixtures are
 * just charges: three from one merchant a month apart, and the page has to
 * decide the rest. The case worth guarding is the one nothing else here can
 * answer — a bill that has **not** arrived, which from inside the budget looks
 * exactly like a quiet week.
 */

/** A charge on a given day. Amounts are magnitudes; the API takes the sign. */
async function charge(
  api: APIRequestContext,
  accountId: string,
  isoDay: string,
  amountCents: string,
  description: string,
): Promise<void> {
  await api.post('/api/transactions', {
    data: { accountId, amountCents, description, postedAt: `${isoDay}T15:00:00Z` },
  });
}

/** Three charges a month apart, ending on the day given. */
async function monthlyBill(
  api: APIRequestContext,
  accountId: string,
  days: readonly string[],
  amountCents = '-11800',
  description = 'CITY WATER UTILITY',
): Promise<void> {
  for (const day of days) await charge(api, accountId, day, amountCents, description);
}

/** The three most recent months, so a bill reads as current whenever this runs. */
function recentMonths(): string[] {
  const days: string[] = [];
  for (let back = 3; back >= 1; back -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back * 30);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

/** Three months of charges that stopped, so the next one is late. */
function overdueMonths(): string[] {
  const days: string[] = [];
  for (let back = 4; back >= 2; back -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back * 30);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

async function openBills(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
}

test('says plainly when nothing has arrived three times yet', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await charge(api, accountId, '2026-08-04', '-11800', 'CITY WATER UTILITY');

  await openBills(signedIn);

  // One sentence and no instructions. "No bills" and "not enough history to
  // tell yet" are different states, and a household three weeks in is always
  // in the second.
  await expect(signedIn.getByText('No bill has arrived three times yet.')).toBeVisible();
});

test('a monthly charge becomes a bill with a date and a delegation', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const home = await makeDelegation(api, 'Home & Grounds');
  await monthlyBill(api, accountId, recentMonths());

  // Filed where they always go, so the page can say where the next one lands.
  const list = await api.get('/api/transactions?limit=100');
  const body = (await list.json()) as { transactions: { id: string }[] };
  for (const transaction of body.transactions) {
    await api.post(`/api/transactions/${transaction.id}/categorize`, {
      data: { delegationId: home },
    });
  }

  await openBills(signedIn);

  await expect(signedIn.getByText('CITY WATER UTILITY')).toBeVisible();
  await expect(signedIn.getByRole('cell', { name: 'Monthly' })).toBeVisible();
  await expect(signedIn.getByRole('cell', { name: 'Home & Grounds' })).toBeVisible();
  await expect(signedIn.getByText('1 recurring.')).toBeVisible();
});

test('the bill that did not arrive is named on the page and in the header', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(api, accountId, overdueMonths());

  await openBills(signedIn);

  await expect(signedIn.getByRole('cell', { name: /Overdue/ })).toBeVisible();
  await expect(signedIn.getByText('1 recurring, 1 overdue.')).toBeVisible();

  // And the pill, which is how somebody who is not on this page finds out.
  const pill = signedIn.getByRole('link', { name: /1 bill overdue/ });
  await expect(pill).toBeVisible();
});

test('the search narrows the list to one bill', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(api, accountId, recentMonths());
  await monthlyBill(api, accountId, recentMonths(), '-4599', 'STREAMING SERVICE');

  await openBills(signedIn);
  await expect(signedIn.getByText('STREAMING SERVICE')).toBeVisible();

  await signedIn.getByLabel('Search bills').fill('water');

  await expect(signedIn.getByText('CITY WATER UTILITY')).toBeVisible();
  await expect(signedIn.getByText('STREAMING SERVICE')).toHaveCount(0);
});

test('the overdue pill can be switched off, and the page stays', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(api, accountId, overdueMonths());

  await signedIn.goto('/settings/budget');
  await signedIn.getByLabel('Tell me when a bill is overdue').click();

  // Assert the write landed before navigating: the settings page saves on
  // change, and arriving anywhere else mid-write reads a stale answer.
  await expect(signedIn.getByLabel('Tell me when a bill is overdue')).not.toBeChecked();

  await openBills(signedIn);

  // Silent, but not hidden. A switch that hid the list as well would make
  // "I turned the noise off" and "there are no bills" impossible to tell apart.
  await expect(signedIn.getByRole('link', { name: /bill overdue/ })).toHaveCount(0);
  await expect(signedIn.getByRole('cell', { name: /Overdue/ })).toBeVisible();
});

/**
 * The escape hatch the first real run asked for.
 *
 * A thrift shop visited every fortnight has exactly the shape of a fortnightly
 * bill, and no threshold will ever know it is a shop. Only the household does,
 * so the page has to let them say it.
 */
test('a merchant that is not a bill is taken off the list, and can come back', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(api, accountId, recentMonths(), '-7150', 'SAVERS - 1090 SIOUX FALLS SD');
  await monthlyBill(api, accountId, recentMonths());

  await openBills(signedIn);
  await expect(signedIn.getByText('SAVERS - 1090 SIOUX FALLS SD')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Options for SAVERS - 1090 SIOUX FALLS SD' }).click();
  await signedIn.getByRole('menuitem', { name: 'Not a bill' }).click();

  await expect(signedIn.getByText('SAVERS - 1090 SIOUX FALLS SD')).toHaveCount(0);
  // The other one is untouched: this is a judgement about one merchant.
  await expect(signedIn.getByText('CITY WATER UTILITY')).toBeVisible();

  // And it is findable again, which is what makes saying it safe.
  await signedIn.getByRole('button', { name: '1 hidden' }).click();
  await signedIn.getByRole('button', { name: 'Put back' }).click();
  await expect(signedIn.getByText('SAVERS - 1090 SIOUX FALLS SD')).toBeVisible();
});

test('a bill can be given a name, and the bank text moves into the menu', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(
    api,
    accountId,
    recentMonths(),
    '-10595',
    'ACH Payment SIOUXFALLS SD UTILITY 605-367-8869',
  );

  await openBills(signedIn);
  await signedIn
    .getByRole('button', { name: 'Options for ACH Payment SIOUXFALLS SD UTILITY 605-367-8869' })
    .click();
  await signedIn.getByRole('menuitem', { name: 'Give it a name' }).click();

  // `getByRole`, not `getByLabel`: the dialog's own name is "Rename …", and an
  // accessible name is matched as a substring — so "Name" resolves to the
  // dialog as well as to the field inside it.
  await signedIn.getByRole('textbox', { name: 'Name' }).fill('Water & Sewer');
  // `exact`, because an accessible name is matched as a substring and a
  // merchant called SAVERS puts "Save" in its row menu's trigger.
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(signedIn.getByText('Water & Sewer')).toBeVisible();

  /*
   * Off the row and into the menu.
   *
   * It was drawn under the name in small grey, which put a line of feed text on
   * every renamed row — the exact noise renaming was for. It is still kept and
   * still searchable; it is one press away for the person reconciling against a
   * statement and invisible to everybody else.
   */
  await expect(signedIn.getByText('ACH Payment SIOUXFALLS SD UTILITY 605-367-8869')).toHaveCount(0);

  await signedIn.getByRole('button', { name: 'Options for Water & Sewer' }).click();
  await expect(signedIn.getByText('ACH Payment SIOUXFALLS SD UTILITY 605-367-8869')).toBeVisible();
});

test('a renamed bill is still found by what the bank calls it', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  await monthlyBill(
    api,
    accountId,
    recentMonths(),
    '-10595',
    'ACH Payment SIOUXFALLS SD UTILITY 605-367-8869',
  );

  await openBills(signedIn);
  await signedIn
    .getByRole('button', { name: 'Options for ACH Payment SIOUXFALLS SD UTILITY 605-367-8869' })
    .click();
  await signedIn.getByRole('menuitem', { name: 'Give it a name' }).click();
  await signedIn.getByRole('textbox', { name: 'Name' }).fill('Water & Sewer');
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // Searching for the statement's words has to reach the row, or a rename
  // would make a bill unfindable by the only name a bank statement knows.
  await signedIn.getByLabel('Search bills').fill('siouxfalls');
  await expect(signedIn.getByText('Water & Sewer')).toBeVisible();
});

/**
 * Saying so by hand, for the case no threshold reaches.
 *
 * A merchant that renames itself between charges gets a new merchant key, so its
 * old bill goes overdue for ever while the new one has too little history to be
 * detected at all. Only the household knows they are the same bill.
 *
 * The sibling case — a charge that has arrived but is still *pending* — is
 * covered in the integration tests, because a pending row cannot be created
 * through the API a person uses.
 */
test('a charge can be attached to a bill, and detached again', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Frontier Checking', 'asset', 500000n);
  await monthlyBill(api, accountId, overdueMonths(), '-3096', 'LINCOLN LIFE PREMIUM');

  // The same bill under the insurer's new name — on its own, too little history
  // to be detected as anything. Yesterday, so it is inside the window of charges
  // the dialog offers around the date this bill was expected.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  await charge(
    api,
    accountId,
    yesterday.toISOString().slice(0, 10),
    '-3096',
    'PROTECTIVE LIFE PREMIUM',
  );

  await openBills(signedIn);
  await expect(signedIn.getByText(/Overdue/)).toBeVisible();

  await signedIn.getByRole('button', { name: 'Options for LINCOLN LIFE PREMIUM' }).click();
  await signedIn.getByRole('menuitem', { name: /^The charge did arrive/ }).click();
  await signedIn.getByRole('button', { name: /^Attach PROTECTIVE LIFE PREMIUM/ }).click();

  /*
   * Not overdue any more — and the bill keeps the merchant's own name rather
   * than taking the name of the charge attached to it, which would rename the
   * row to the thing that went wrong.
   */
  await expect(signedIn.getByText(/Overdue/)).toHaveCount(0);
  await expect(signedIn.getByText('LINCOLN LIFE PREMIUM')).toBeVisible();

  // And it comes back off.
  await signedIn.getByRole('button', { name: 'Options for LINCOLN LIFE PREMIUM' }).click();
  await signedIn.getByRole('menuitem', { name: /^The charge did arrive/ }).click();
  await signedIn.getByRole('button', { name: /^Detach PROTECTIVE LIFE PREMIUM/ }).click();
  await signedIn.getByRole('button', { name: 'Done' }).click();

  await expect(signedIn.getByText(/Overdue/)).toBeVisible();
});
