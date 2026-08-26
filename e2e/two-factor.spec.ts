import type { Page } from '@playwright/test';
import { generate as generateOtp } from 'otplib';
import { expect, OWNER, test } from './fixtures.js';

/**
 * Two-factor authentication, through the screens the household actually uses.
 *
 * The proof that matters is the last step of each: everything before it can
 * look finished while the password alone still opens the budget.
 *
 * A second factor is required of every account now, so the fixture arrives
 * already enrolled — through the API, for speed, across all twenty specs. These
 * tests therefore start by turning it *off* from the Security page, which is
 * how they reach the enrolment screen and how the disable path gets exercised
 * at all.
 */

/**
 * The setup key, from behind "Can't scan this?".
 *
 * The QR code is the offered path and the key is folded away behind a button,
 * so reaching it is a click. It is displayed in groups of four for reading and
 * typing; the spaces are for the eye and come straight back out here, which is
 * the same thing the Copy button does.
 */
async function revealSecret(page: Page): Promise<string> {
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await page.getByRole('button', { name: /Can.t scan this/ }).click();

  const shown = (await page.locator('p.font-mono').first().innerText()).trim();
  const secret = shown.replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  return secret;
}

/**
 * Removes the factor the fixture enrolled, leaving the real screen to re-do it.
 *
 * The status line is waited for before anything is typed. This card reads its
 * state from a query, and typing into a controlled input while that query is
 * still in flight loses the keystrokes to the re-render that follows — the
 * field ends up empty, the button stays disabled, and the failure reads as a
 * missing button rather than a race. It passed for weeks and then did not, on
 * the run after a second card was added to the same page.
 */
async function turnItOff(page: Page): Promise<void> {
  await page.goto('/settings/users');
  await expect(page.getByText('recovery codes left.', { exact: false })).toBeVisible();

  await page.getByLabel('Current password').fill(OWNER.password);
  // Enabled only once the field genuinely holds a password.
  await expect(page.getByRole('button', { name: 'Turn off two-factor' })).toBeEnabled();

  await page.getByRole('button', { name: 'Turn off two-factor' }).click();
  await expect(page.getByRole('button', { name: 'Set up two-factor' })).toBeVisible();
}

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
  await turnItOff(page);

  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  const secret = await revealSecret(page);

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
  await turnItOff(page);
  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  const secret = await revealSecret(page);
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
  await page.goto('/settings/users');
  await expect(page.getByText('9 recovery codes left.')).toBeVisible();
});

test('refuses a wrong code without giving up the session', async ({ signedIn: page }) => {
  await turnItOff(page);
  // The password again: binding an authenticator from a session somebody else
  // is holding would give them a credential you never issued.
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  const secret = await revealSecret(page);
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

/**
 * Enrolling without a second device.
 *
 * A QR code is useless in exactly the case a household hits most: setting the
 * second factor up in a password manager on the machine already showing the
 * screen, or on the phone that is holding it. There is no second camera to point
 * at anything.
 */
test('the setup key is folded away until asked for, then offered to be copied', async ({
  signedIn: page,
}) => {
  await turnItOff(page);
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  // The QR code is the offered path and stays first.
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(page.locator('p.font-mono')).toHaveCount(0);

  await page.getByRole('button', { name: /Can.t scan this/ }).click();

  const shown = (await page.locator('p.font-mono').first().innerText()).trim();
  // Grouped in fours for reading and typing.
  expect(shown.replace(/\s+/g, ' ')).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy the setup key' }).click();
  await expect(page.getByRole('status')).toContainText('Copied.');

  // What lands on the clipboard is the key without the spaces. A password
  // manager given "ABCD EFGH" may keep the space, and a second factor producing
  // codes that match nothing is found out at the worst possible moment.
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(shown.replace(/\s+/g, ''));
  expect(clipboard).toMatch(/^[A-Z2-7]+$/);

  // And it is the real secret, not a rendering of one.
  await page.getByLabel('Code from the app').fill(await generateOtp({ secret: clipboard }));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Two-factor is on.', { exact: false })).toBeVisible();
});

/**
 * The case the fallback exists for.
 *
 * `navigator.clipboard` is only present in a secure context, and this
 * application serves plain http at the origin by decision (ADR 017) — so on the
 * LAN address, which is the one used most, it is absent. A copy button written
 * against it alone would do nothing on the very device it was added for, and do
 * it silently.
 */
test('the copy button still says something useful where there is no clipboard API', async ({
  signedIn: page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  await turnItOff(page);
  await page.getByLabel('Current password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await page.getByRole('button', { name: /Can.t scan this/ }).click();

  await expect(page.evaluate(() => navigator.clipboard)).resolves.toBeUndefined();

  await page.getByRole('button', { name: 'Copy the setup key' }).click();

  // Either it copied by selection or it asked the reader to press the key. What
  // it must never do is nothing at all, silently.
  await expect(page.getByRole('status')).toContainText(/Copied|press .* to copy it/);

  // Selected either way, so the keystroke it names actually works.
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.replace(/\s+/g, '')).toMatch(/^[A-Z2-7]+$/);
});
