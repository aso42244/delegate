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

test('compares the suggestion against what is actually funded', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  // Funded at $2.00 a cycle. One $130 bill averages to about $11.81 a month,
  // which is about $5.45 a cycle — so this line is genuinely under-funded, which
  // is the case worth showing.
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

  // The comparison the page exists for, stated in words.
  await expect(signedIn.getByText(/below the suggestion/)).toBeVisible();
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

  // The purple of the grouping, not the accent blue.
  const bar = signedIn.locator('[aria-hidden] > div').first();
  await expect(bar).toHaveCSS('background-color', 'rgb(139, 99, 184)');
});
