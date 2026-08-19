import type { Page } from '@playwright/test';
import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Settings → Connections: issuing the credential an MCP client signs in with.
 *
 * The assertion that matters is the last one in each test. A page that lists
 * connections and a page that issues working ones look identical until
 * something actually authenticates with what it printed — so every test here
 * takes the key it was shown and uses it from a context holding no cookie.
 */

/** Issues a connection through the UI and returns the key it showed once. */
async function issue(page: Page, name: string, allowChanges: boolean): Promise<string> {
  await page.goto('/settings/connections');

  await page.getByLabel('What is connecting?').fill(name);
  if (allowChanges) {
    await page.getByRole('switch', { name: 'Allow this connection to make changes' }).click();
  }
  await page.getByRole('button', { name: 'Create connection' }).click();

  const field = page.getByLabel('The new connection key');
  await expect(field).toBeVisible();

  const secret = await field.inputValue();
  expect(secret).toMatch(/^dlg_[0-9a-f]{16}_/);
  return secret;
}

test('a read-only connection reads the budget and cannot change it', async ({
  signedIn,
  api,
  request,
}) => {
  await makeDelegation(api, 'Grocery');
  const secret = await issue(signedIn, 'Claude on the laptop', false);
  const headers = { authorization: `Bearer ${secret}` };

  // `request` carries no session cookie, so the token is standing on its own.
  expect((await request.get('/api/budget', { headers })).status()).toBe(200);
  expect((await request.post('/api/budget/transfer', { headers, data: {} })).status()).toBe(403);

  await signedIn.getByRole('button', { name: 'I have saved it' }).click();
  await expect(signedIn.getByText('Claude on the laptop')).toBeVisible();
  // Exact: the toggle's own description also contains the words, and a
  // substring match resolves to both.
  await expect(signedIn.getByText('Read-only', { exact: true })).toBeVisible();
});

test('a connection that may make changes can categorize, and nothing more', async ({
  signedIn,
  api,
  request,
}) => {
  const accountId = await makeAccount('Checking', 'asset', 500_000n);
  const delegationId = await makeDelegation(api, 'Grocery');

  const created = await api.post('/api/transactions', {
    data: {
      accountId,
      amountCents: '-2500',
      description: 'Corner shop',
      postedAt: '2026-08-05T00:00:00.000Z',
    },
  });
  const { transaction } = (await created.json()) as { transaction: { id: string } };

  const secret = await issue(signedIn, 'Claude with write access', true);
  const headers = { authorization: `Bearer ${secret}` };

  const categorize = await request.post(`/api/transactions/${transaction.id}/categorize`, {
    headers,
    data: { delegationId },
  });
  expect(categorize.status()).toBe(200);

  // Allowed to write a rule; never allowed to run one over the whole history.
  expect((await request.post('/api/rules/apply', { headers, data: {} })).status()).toBe(403);

  await signedIn.getByRole('button', { name: 'I have saved it' }).click();
  await expect(signedIn.getByText('Can make changes', { exact: true })).toBeVisible();
});

test('switching a connection off stops it working immediately', async ({ signedIn, request }) => {
  const secret = await issue(signedIn, 'A laptop that got lost', false);
  const headers = { authorization: `Bearer ${secret}` };

  expect((await request.get('/api/budget', { headers })).status()).toBe(200);

  await signedIn.getByRole('button', { name: 'I have saved it' }).click();
  await signedIn.getByRole('button', { name: 'Switch off' }).click();

  // The tag appearing is the signal that the revocation landed. Asking the API
  // before it does would be racing the write.
  await expect(signedIn.getByText('Switched off', { exact: true })).toBeVisible();

  expect((await request.get('/api/budget', { headers })).status()).toBe(401);
});

test('the key is shown once and never again', async ({ signedIn }) => {
  const secret = await issue(signedIn, 'Shown once', false);

  await signedIn.getByRole('button', { name: 'I have saved it' }).click();
  await expect(signedIn.getByText('Shown once')).toBeVisible();

  await signedIn.reload();
  await expect(signedIn.getByText('Shown once')).toBeVisible();
  await expect(signedIn.getByText(secret)).toHaveCount(0);
});

/**
 * The whole point of the connector: an install path with no terminal in it.
 *
 * The bundle is built into the image, so this also proves the file survived the
 * trip — a download button that 404s is worse than no download button, because
 * it looks like the feature exists.
 */
test('the connector downloads as a file Claude Desktop can install', async ({ signedIn }) => {
  await signedIn.goto('/settings/connections');

  const started = signedIn.waitForEvent('download');
  await signedIn.getByRole('button', { name: 'Download connector' }).click();

  const download = await started;
  expect(download.suggestedFilename()).toBe('delegate.mcpb');
});

test('the address to paste is the one this page was reached on', async ({ signedIn, baseURL }) => {
  await signedIn.goto('/settings/connections');

  // Not a guess at a LAN address: whatever reached this page reaches the budget.
  await expect(signedIn.getByText(baseURL!, { exact: true })).toBeVisible();
});
