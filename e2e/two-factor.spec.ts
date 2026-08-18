import type { Page } from '@playwright/test';
import { generate as generateOtp } from 'otplib';
import { expect, OWNER, test } from './fixtures.js';

/**
 * Two-factor authentication, through the screens the household actually uses:
 * enrol, sign out, sign back in with a code.
 *
 * The proof that matters is the last step. Everything before it can look
 * finished while the password alone still opens the budget.
 */

/**
 * Drops the session and lands on a freshly mounted sign-in screen.
 *
 * Clearing the cookie rather than clicking Sign out: what is under test here is
 * the sign-in that follows, and reloading guarantees it starts from a clean
 * component state rather than whatever the previous page left behind.
 */
async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();
}

test('enrols, then requires a code on the next sign-in', async ({ signedIn: page }) => {
  await page.goto('/settings/security');

  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  // The secret is offered as text beside the QR code, for anyone typing it in.
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  const secret = (await page.locator('p.font-mono').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]+$/);

  await page.getByLabel('Code from the app').fill(await generateOtp({ secret }));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page.getByText('Two-factor is on.', { exact: false })).toBeVisible();
  const codes = await page.locator('ul.font-mono li').allInnerTexts();
  expect(codes).toHaveLength(10);

  await page.getByRole('button', { name: 'I have written them down' }).click();
  await expect(page.getByText('10 recovery codes left.')).toBeVisible();

  await signOut(page);

  // The password alone must not get in.
  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByLabel('Authentication code')).toBeVisible();
  expect(page.url()).toContain('/login');

  await page.getByLabel('Authentication code').fill(await generateOtp({ secret }));
  await page.getByRole('button', { name: 'Verify' }).click();

  await page.waitForURL('/');
});

test('a recovery code gets in when the phone is gone, and is then spent', async ({
  signedIn: page,
}) => {
  await page.goto('/settings/security');
  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  const secret = (await page.locator('p.font-mono').first().innerText()).trim();
  await page.getByLabel('Code from the app').fill(await generateOtp({ secret }));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page.getByText('Two-factor is on.', { exact: false })).toBeVisible();
  const recoveryCode = (await page.locator('ul.font-mono li').first().innerText()).trim();
  await page.getByRole('button', { name: 'I have written them down' }).click();
  await expect(page.getByText('10 recovery codes left.')).toBeVisible();

  await signOut(page);

  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill(recoveryCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL('/');

  // Spent, not merely accepted: the count is what tells the household how many
  // ways back in they have left.
  await page.goto('/settings/security');
  await expect(page.getByText('9 recovery codes left.')).toBeVisible();
});

test('refuses a wrong code without giving up the session', async ({ signedIn: page }) => {
  await page.goto('/settings/security');
  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  const secret = (await page.locator('p.font-mono').first().innerText()).trim();
  await page.getByLabel('Code from the app').fill(await generateOtp({ secret }));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Two-factor is on.', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'I have written them down' }).click();
  await signOut(page);

  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByText('That code is not correct.')).toBeVisible();
  expect(page.url()).toContain('/login');
});
