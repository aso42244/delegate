import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * The Utilities page.
 *
 * It suggests and never writes. The assertion that matters is that the
 * configured amount to delegate is untouched by anything on this page.
 */

test('says plainly when there are no utilities yet', async ({ signedIn }) => {
  await signedIn.goto('/utilities');

  await expect(signedIn.getByRole('heading', { name: 'Utilities' })).toBeVisible();
  await expect(signedIn.getByText('No delegations are marked as a utility yet.')).toBeVisible();
});

test('shows a card per utility, and warns that averages need history', async ({
  signedIn,
  api,
}) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/utilities');

  await expect(signedIn.getByRole('heading', { name: 'Water' })).toBeVisible();
  // Honest about being empty rather than presenting zeros as findings.
  await expect(signedIn.getByText(/need categorized history/)).toBeVisible();
});

test('compares the suggestion against what is actually delegated', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  // Delegated at $2.00 a cycle. One $130 bill averages to about $11.81 a month,
  // which is about $5.45 a cycle — so this line genuinely has too little
  // delegated to it, which is the case worth showing.
  const water = await makeDelegation(api, 'Water', '200');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  // A bill in a completed month, so the average is not zero.
  const lastMonth = new Date();
  lastMonth.setUTCDate(1);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  lastMonth.setUTCDate(15);

  const created = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-13000',
      description: 'Water bill',
      postedAt: lastMonth.toISOString(),
    },
  });
  const { transaction } = (await created.json()) as { transaction: { id: string } };
  await api.post(`/api/transactions/${transaction.id}/categorize`, {
    data: { delegationId: water },
  });

  await signedIn.goto('/utilities');

  // The comparison the page exists for, named rather than left to a colour.
  await expect(signedIn.getByText('Delegated below suggested')).toBeVisible();
});

/** §9.3: suggest only, never auto-write. */
test('never changes the amount to delegate', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '2000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/utilities');
  await expect(signedIn.getByRole('heading', { name: 'Water' })).toBeVisible();

  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Water amount to delegate' })).toContainText(
    '$20.00',
  );
});

/**
 * The bars take the grouping's colour, so a card reads as one thing rather than
 * as a coloured dot beside an unrelated blue chart.
 */
test('the sparkline takes the grouping colour', async ({ signedIn, api }) => {
  const grouping = await api.post('/api/groupings', {
    data: { name: 'Home', section: 'delegations', color: '#8B63B8' },
  });
  const { grouping: home } = (await grouping.json()) as { grouping: { id: string } };

  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const electricity = await makeDelegation(api, 'Electricity');
  await api.patch(`/api/delegations/${electricity}`, {
    data: { isUtility: true, groupingId: home.id },
  });

  const spend = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-6500',
      description: 'Power company',
      postedAt: '2026-07-05T00:00:00Z',
    },
  });
  const { transaction } = (await spend.json()) as { transaction: { id: string } };
  await api.post(`/api/transactions/${transaction.id}/categorize`, {
    data: { delegationId: electricity },
  });

  await signedIn.goto('/utilities');
  await expect(signedIn.getByText('Electricity')).toBeVisible();

  // The purple of the grouping, not the accent blue. The bar sits inside a
  // full-height column, which is what gives a spent-nothing month something to
  // hover over.
  const bar = signedIn.locator('.group\\/bar > div').first();
  await expect(bar).toHaveCSS('background-color', 'rgb(139, 99, 184)');
});

/**
 * Every figure on the card carries its unit.
 *
 * The monthly average used to lead in hero type with an unlabelled "Currently"
 * beside it — a per-month figure and a per-paycheck one, adjacent and looking
 * comparable. The two per-cycle numbers are the comparison, so they are the two
 * that sit together now.
 */
test('the card compares like with like', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const electricity = await makeDelegation(api, 'Electricity', '6500');
  await api.patch(`/api/delegations/${electricity}`, { data: { isUtility: true } });

  const spend = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-26000',
      description: 'Power company',
      postedAt: '2026-07-05T00:00:00Z',
    },
  });
  const { transaction } = (await spend.json()) as { transaction: { id: string } };
  await api.post(`/api/transactions/${transaction.id}/categorize`, {
    data: { delegationId: electricity },
  });

  await signedIn.goto('/utilities');

  // Every figure names its unit, so a monthly one and a per-cycle one cannot be
  // read as comparable. That was the bug: "Currently $65.00" beside a
  // per-paycheck suggestion, carrying no unit at all.
  await expect(signedIn.getByText('Average per month')).toBeVisible();
  await expect(signedIn.getByText('Suggested per cycle')).toBeVisible();
  await expect(signedIn.getByText('Delegated per cycle')).toBeVisible();
  await expect(signedIn.getByText('Currently', { exact: true })).toHaveCount(0);

  // And "delegated" throughout — the application has one word for this.
  await expect(signedIn.getByText('Funded', { exact: false })).toHaveCount(0);
});

/**
 * Pay cadence, from the setting to the figure it changes.
 *
 * The arithmetic is proved elsewhere. What only a browser can show is that the
 * choice made on one page reaches the number on another, and that the sentence
 * explaining the number names the same divisor it was computed from — a page
 * saying "over 26" beside a figure computed from 12 is worse than either alone.
 */
test('changing the pay cadence changes the suggestion and the sentence', async ({
  signedIn,
  api,
}) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  /*
   * One $132 bill in a completed month.
   *
   * The average is the mean over the eleven *complete* months in the window,
   * not over the months that happen to have a bill — so this is $12.00 a month,
   * and $144 a year.
   *
   * Monthly is deliberately not the cadence under test here: twelve months over
   * twelve paychecks makes the suggestion equal the average, and two identical
   * figures on one card cannot be told apart by a test. Weekly keeps all three
   * numbers distinct.
   */
  const lastMonth = new Date();
  lastMonth.setUTCDate(1);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  lastMonth.setUTCDate(15);

  const created = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-13200',
      description: 'Water bill',
      postedAt: lastMonth.toISOString(),
    },
  });
  const { transaction } = (await created.json()) as { transaction: { id: string } };
  await api.post(`/api/transactions/${transaction.id}/categorize`, {
    data: { delegationId: water },
  });

  // Biweekly by default: $144 a year over 26 is $5.54.
  await signedIn.goto('/utilities');
  await expect(signedIn.getByText('$12.00')).toBeVisible();
  await expect(signedIn.getByText('$5.54')).toBeVisible();

  await signedIn.goto('/settings/budget');
  await signedIn.getByLabel('Paid').selectOption('weekly');

  // The field's own copy updating is the signal the write landed; reading the
  // other page before it does would race the save.
  await expect(signedIn.getByText(/52 paychecks a year/)).toBeVisible();

  // $144 a year over 52 is $2.77. The average is untouched.
  await signedIn.goto('/utilities');
  await expect(signedIn.getByText('$12.00')).toBeVisible();
  await expect(signedIn.getByText('$2.77')).toBeVisible();
});

test('the amount to delegate is left alone when the cadence changes', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/settings/budget');
  await signedIn.getByLabel('Paid').selectOption('weekly');
  await expect(signedIn.getByText(/52 paychecks a year/)).toBeVisible();

  // Still $60.00 a press. Changing how often you are paid does not decide how
  // much goes into an envelope — that stays the household's call.
  await signedIn.goto('/');
  await expect(signedIn.getByRole('button', { name: 'Water amount to delegate' })).toContainText(
    '$60.00',
  );
});
