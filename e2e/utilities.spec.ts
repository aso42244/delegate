import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * The Cost half of Recurring.
 *
 * It suggests and never writes. The assertion that matters is that the
 * configured amount to delegate is untouched by anything here.
 *
 * Since ADR 061 it is two tiles of dense rows rather than a grid of cards, so
 * what is asserted moved with it: the four labelled figures per card are a
 * per-cycle comparison in one tile and twelve months in the other, and each
 * row's hover text carries both units — a per-month figure and a per-cycle one
 * adjacent and looking comparable is the bug those labels were written for.
 */

test('says plainly when there are no utilities yet', async ({ signedIn }) => {
  // The old address still works: a bookmark is a promise, and the thing it
  // pointed at is on this page.
  await signedIn.goto('/utilities');

  await expect(signedIn.getByRole('heading', { name: 'Recurring' })).toBeVisible();
  await expect(signedIn.getByRole('heading', { name: 'Per cycle' })).toBeVisible();
  await expect(signedIn.getByText('No delegations are marked as a utility.')).toBeVisible();
});

test('shows a row per utility, and warns that averages need history', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '6000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/utilities');

  // A row in each tile rather than a card of its own.
  await expect(signedIn.getByText('Water').first()).toBeVisible();
  // Honest about being empty rather than presenting zeros as findings.
  await expect(signedIn.getByText(/categorized history/)).toBeVisible();
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

  // The comparison the page exists for, named rather than left to a colour —
  // §9: never convey state by colour alone. The warning tone on the delegated
  // figure is how fast it is read; the footer is what it means.
  await expect(signedIn.getByText(/delegated below suggested/i)).toBeVisible();
});

/** §9.3: suggest only, never auto-write. */
test('never changes the amount to delegate', async ({ signedIn, api }) => {
  const water = await makeDelegation(api, 'Water', '2000');
  await api.patch(`/api/delegations/${water}`, { data: { isUtility: true } });

  await signedIn.goto('/utilities');
  await expect(signedIn.getByText('Water').first()).toBeVisible();

  await signedIn.goto('/budget');
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
  await expect(signedIn.getByText('Electricity').first()).toBeVisible();

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

  /*
   * Every figure names its unit, so a monthly one and a per-cycle one cannot be
   * read as comparable. That was the bug: "Currently $65.00" beside a
   * per-paycheck suggestion, carrying no unit at all.
   *
   * The two per-cycle figures share a row, and the row's hover text names both
   * of them — which is where a unit goes when a dense list has no room for a
   * label a figure. The monthly average is a tile of its own and its heading
   * carries the unit for the whole column.
   */
  await expect(signedIn.getByText('Delegated against suggested')).toBeVisible();
  await expect(signedIn.getByText('Average per month')).toBeVisible();

  await expect(
    signedIn.getByRole('listitem').filter({ hasText: 'Electricity' }).first(),
  ).toHaveAttribute('title', /delegated per cycle .* suggested per cycle/);

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
  await signedIn.getByLabel('Pay cadence').selectOption('weekly');

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
  await signedIn.getByLabel('Pay cadence').selectOption('weekly');
  await expect(signedIn.getByText(/52 paychecks a year/)).toBeVisible();

  // Still $60.00 a press. Changing how often you are paid does not decide how
  // much goes into an envelope — that stays the household's call.
  await signedIn.goto('/budget');
  await expect(signedIn.getByRole('button', { name: 'Water amount to delegate' })).toContainText(
    '$60.00',
  );
});
