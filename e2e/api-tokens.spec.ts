import { expect, makeAccount, test } from './fixtures.js';

/**
 * Settings → Access → API tokens, through the screen the household uses.
 *
 * The proof that matters is at the far end: a token made on this card opens the
 * read door and nothing else, and once revoked here it opens nothing. The card
 * is also where "when was it last used, and from where" is answered, so that is
 * read back too.
 */

test('a token is made once, shown once, used, and revoked', async ({ signedIn: page }) => {
  await makeAccount('Everyday Checking', 'asset', 500000n);

  await page.goto('/settings/access');
  await expect(page.getByText('No tokens yet.')).toBeVisible();

  await page.getByRole('button', { name: 'New token' }).click();
  const dialog = page.getByRole('dialog', { name: 'New token' });
  await dialog.getByLabel('Name').fill('Eventide');
  await dialog.getByRole('button', { name: 'Create' }).click();

  // The one time the secret is on a screen.
  const shown = page.getByRole('dialog', { name: 'Token for Eventide' });
  await expect(shown).toBeVisible();
  const secret = (await shown.locator('p.font-mono').first().innerText()).trim();
  expect(secret).toMatch(/^dlg_[A-Za-z0-9_-]{43}$/);
  await shown.getByRole('button', { name: 'Done' }).click();

  // And never again: the row is there, the secret is not.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('row', { name: /Eventide/ });
  await expect(row).toContainText('Never');
  await expect(row).toContainText('Active');
  await expect(page.getByText(secret)).toHaveCount(0);

  // It opens the door, and the door answers cents as strings.
  const opened = await page.request.get('/api/read/budget', {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(opened.status()).toBe(200);
  const budget = (await opened.json()) as { identity: { assetsCents: string } };
  expect(budget.identity.assetsCents).toBe('500000');

  // The card says so: last used, and from where.
  await page.reload();
  const used = page.getByRole('row', { name: /Eventide/ });
  await expect(used).not.toContainText('Never');
  await expect(used).toContainText('127.0.0.1');

  // Revoked from the row, and the door is shut.
  await page.getByRole('button', { name: 'Options for Eventide' }).click();
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  await expect(page.getByRole('row', { name: /Eventide/ })).toContainText('Revoked');

  const shut = await page.request.get('/api/read/budget', {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(shut.status()).toBe(401);
});

test('a signed-in browser cannot read through the door, and a token cannot reach the page', async ({
  signedIn: page,
}) => {
  // The session this page holds is not a bearer token.
  const asBrowser = await page.request.get('/api/read/budget');
  expect(asBrowser.status()).toBe(401);
  expect(((await asBrowser.json()) as { error: { code: string } }).error.code).toBe(
    'bearer_required',
  );

  await page.goto('/settings/access');
  await page.getByRole('button', { name: 'New token' }).click();
  const dialog = page.getByRole('dialog', { name: 'New token' });
  await dialog.getByLabel('Name').fill('Eventide');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Token for Eventide' });
  const secret = (await shown.locator('p.font-mono').first().innerText()).trim();
  await shown.getByRole('button', { name: 'Done' }).click();

  // A fresh context with no cookie and only the token: the door opens, the
  // budget's own API does not.
  const asMachine = await page.context().browser()!.newContext();
  try {
    const machine = asMachine.request;
    const door = await machine.get('/api/read/overview', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(door.status()).toBe(200);

    const budget = await machine.get('/api/budget', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(budget.status()).toBe(401);
  } finally {
    await asMachine.close();
  }

  // Issuing and revoking are credential changes, and the household's log says so.
  await expect(page.getByText('API token issued')).toBeVisible();
});
