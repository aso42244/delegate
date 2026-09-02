import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * The export.
 *
 * A download rather than a rendered page, so the thing to prove is that the
 * browser actually receives a file it will save — the link is a plain navigation
 * carrying the session cookie, and the failure mode if that were wrong is a
 * sign-in page saved as `transactions.csv`.
 */

test('the register downloads as a CSV a spreadsheet can read', async ({ signedIn, api }) => {
  const accountId = await makeAccount('Everyday Checking', 'asset', 500000n);
  const grocery = await makeDelegation(api, 'Grocery');
  const created = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-4210',
      description: 'Whole Foods Market',
      postedAt: '2026-08-05T00:00:00Z',
    },
  });
  const { transaction } = (await created.json()) as { transaction: { id: string } };
  await api.post(`/api/transactions/${transaction.id}/categorize`, {
    data: { delegationId: grocery },
  });

  await signedIn.goto('/settings/sync');

  const download = signedIn.waitForEvent('download');
  await signedIn.getByRole('link', { name: 'Download transactions as CSV' }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/^delegate-transactions-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');

  expect(body).toContain('"date","description"');
  expect(body).toContain('"Whole Foods Market"');
  // A decimal, not cents: this column is one somebody sums.
  expect(body).toContain('"-42.10"');
  expect(body).toContain('"Grocery"');
});
