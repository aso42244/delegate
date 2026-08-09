import { test as base, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * Fixtures for the end-to-end tests.
 *
 * Every fixture is built through the application's own API, so the tests
 * exercise the same paths the household does. Credentials here are invented for
 * the run and belong to nobody.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['TEST_DATABASE_URL'] ?? '' } },
});

export const OWNER = { username: 'e2e-owner@example.test', password: 'end-to-end-passphrase' };

/** Order matters: children before parents, because these are real foreign keys. */
async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      delegation_events, transaction_allocations, delegation_transfers, delegate_runs,
      transactions, categorization_rules, account_valuations, accounts, delegations,
      groupings, sessions, users, sync_runs, bitcoin_prices
    RESTART IDENTITY CASCADE
  `);
  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, undoWindowHours: 12, identityToleranceCents: 500n },
    update: {
      undoWindowHours: 12,
      identityToleranceCents: 500n,
      goLiveAt: null,
      requireTotp: false,
      simplefinAccessUrlEncrypted: null,
    },
  });
}

export interface BudgetFixtures {
  /** A signed-in page, with the first-run Super Admin already created. */
  readonly signedIn: Page;
  /** An API context sharing the signed-in session, for building fixtures fast. */
  readonly api: APIRequestContext;
}

export const test = base.extend<BudgetFixtures>({
  signedIn: async ({ page }, use) => {
    await resetDatabase();

    // Created through the real setup screen rather than seeded directly: this is
    // the one flow every deployment goes through exactly once, so it is worth
    // exercising on every run.
    await page.goto('/login');
    await page.getByLabel('Username').fill(OWNER.username);
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await page.getByLabel('Confirm password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('/');

    await use(page);
  },

  api: async ({ signedIn, playwright, baseURL }, use) => {
    // Reuses the browser's cookies, so fixture-building goes through the same
    // session the page is using.
    const cookies = await signedIn.context().cookies();
    const context = await playwright.request.newContext({
      // Spread rather than passed directly: exactOptionalPropertyTypes rejects
      // an explicit undefined here.
      ...(baseURL === undefined ? {} : { baseURL }),
      extraHTTPHeaders: {
        cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      },
    });

    await use(context);
    await context.dispose();
  },
});

export { expect } from '@playwright/test';

/** Creates a delegation with an optional amount to delegate, in cents. */
export async function makeDelegation(
  api: APIRequestContext,
  name: string,
  amountToDelegateCents: string | null = null,
): Promise<string> {
  const response = await api.post('/api/delegations', {
    data: { name, amountToDelegateCents },
  });
  const body = (await response.json()) as { delegation: { id: string } };
  return body.delegation.id;
}

/**
 * Creates an in-budget account directly.
 *
 * `source` matters to more than provenance: a SimpleFIN balance is the
 * institution's to state, so the application refuses to let one be typed. Seeded
 * here rather than through the API because only a sync creates a feed-owned
 * account.
 */
export async function makeAccount(
  name: string,
  type: 'asset' | 'debt',
  balanceCents: bigint,
  source: 'manual' | 'simplefin' = 'manual',
): Promise<string> {
  const account = await prisma.account.create({
    data: {
      name,
      type,
      source,
      ...(source === 'simplefin' ? { externalId: `e2e-${name}` } : {}),
      balanceCents,
      inBudget: true,
      inNetWorth: true,
      balanceAsOf: new Date(),
    },
    select: { id: true },
  });
  return account.id;
}
