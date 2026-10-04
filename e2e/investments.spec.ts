import { expect, makeAccount, makePosition, test } from './fixtures.js';

/**
 * Brokerage positions, their purchases, and the S&P 500 (ADR 080).
 */

test('a purchase recorded against a position is held to the feed and compared with the S&P 500', async ({
  signedIn,
}) => {
  const accountId = await makeAccount('Brokerage', 'asset', 300_000n, 'simplefin');
  await makePosition(accountId, 'VTI', {
    sharesMicros: 10_000_000n,
    marketValueCents: 300_000n,
    costBasisCents: 250_000n,
    closes: [
      { date: '2025-03-07', closeCents: 50_000n },
      { date: '2026-10-02', closeCents: 55_000n },
    ],
  });

  await signedIn.goto('/settings/holdings');
  await expect(signedIn.getByRole('heading', { name: /VTI/ })).toBeVisible();
  await expect(signedIn.getByText('No purchases recorded yet.')).toBeVisible();

  await signedIn.getByRole('button', { name: 'Record a purchase' }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Record a purchase of VTI' });
  await dialog.getByLabel('Bought on').fill('2025-03-07');
  await dialog.getByLabel('Shares').fill('10');
  await dialog.getByLabel('Cost, fees included').fill('2500.00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  // Held to the feed: ten shares and $2,500, to the share and to the cent.
  await expect(
    signedIn.getByText('Purchases match the feed’s shares and cost basis to the cent.'),
  ).toBeVisible();
  // $2,500 in the S&P at $500, now $550, is $2,750.
  const row = signedIn.getByRole('row').filter({ hasText: 'Mar 7, 2025' });
  await expect(row).toContainText('$3,000.00');
  await expect(row).toContainText('$2,750.00');

  // On Overview, the position against the index: $3,000 against $2,750.
  const layout = await signedIn.request.put('/api/overview/layout', {
    data: { tiles: [{ key: 'investments', row: 0, position: 0 }] },
  });
  expect(layout.ok()).toBe(true);
  await signedIn.goto('/overview');
  const tile = signedIn
    .getByRole('heading', { name: 'Investments against the S&P 500', level: 2 })
    .locator('../..');
  await expect(tile.getByText('VTI')).toBeVisible();
  await expect(tile.getByText('+$250.00')).toBeVisible();
});
