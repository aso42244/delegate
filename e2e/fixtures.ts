import { test as base, type APIRequestContext, type Page } from '@playwright/test';
import { generate as generateOtp } from 'otplib';
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
  /*
   * Every table, discovered rather than listed.
   *
   * This was a hand-maintained list, and a new table left off it leaked rows
   * from one test into the next — four separate times, each found as a
   * confusing failure somewhere unrelated rather than as a missing name here.
   * Asking the database what tables exist cannot fall behind the schema.
   *
   * The exclusions are Prisma's migration table, which is not test data, and the
   * two pinned singletons — rows the application updates by id and never
   * creates. Truncating those turns every write into "no record was found".
   * They are reset in place below instead.
   */
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'budget_settings', 'bitcoin_node_config')
  `;

  if (tables.length > 0) {
    const quoted = tables.map((table) => `"${table.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }

  await prisma.bitcoinNodeConfig.upsert({
    where: { id: 1 },
    create: { id: 1, mode: 'none' },
    update: {
      mode: 'none',
      baseUrl: null,
      useTor: false,
      lastCheckedAt: null,
      lastHeight: null,
      lastError: null,
      lastRoute: null,
    },
  });

  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, undoWindowHours: 12, identityToleranceCents: 500n },
    // Every column, not only the ones a test happens to read: this row survives
    // the truncate, so anything left out of here leaks into the next test.
    update: {
      undoWindowHours: 12,
      identityToleranceCents: 500n,
      goLiveAt: null,
      // The product default. Left out of this list once already, which leaked a
      // cadence from one test into the next and made the suggestion in the
      // following test wrong for reasons nothing in it explained.
      payCadence: 'biweekly',
      remoteOverTorEnabled: false,
      remoteOverTorEnabledAt: null,
      simplefinAccessUrlEncrypted: null,
      simplefinConnectedAt: null,
      bitcoinInBudgetAckAt: null,
    },
  });
}

export interface BudgetFixtures {
  /** A signed-in page, with the first-run Super Admin already created. */
  readonly signedIn: Page;
  /** An API context sharing the signed-in session, for building fixtures fast. */
  readonly api: APIRequestContext;
}

/**
 * The owner's TOTP secret for the current test.
 *
 * A second factor is required of every account including the first one, so
 * every test signs in through enrolment. Specs that sign in a *second* time
 * need to answer the challenge, and this is what they generate a code from.
 */
export let ownerTotpSecret = '';

/** Answers the second-factor challenge on the sign-in screen. */
export async function completeSecondFactor(page: Page): Promise<void> {
  await page
    .getByLabel('Code from your authenticator')
    .fill(await generateOtp({ secret: ownerTotpSecret }));
  await page.getByRole('button', { name: 'Verify' }).click();
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

    /*
     * Straight to enrolment, because there is nowhere else to go.
     *
     * Done over `page.request`, which shares this context's cookies but is not
     * attached to the document: an in-page `fetch` races the navigation the
     * app is already making and fails as "Failed to fetch" perhaps one run in
     * twenty. The API rather than the screen because this runs before all
     * twenty specs and only one of them is about enrolment — that one drives
     * the real interface. The secret is kept so a spec can sign in again.
     */
    await page.waitForURL('/set-up-two-factor');

    const begun = await page.request.post('/api/auth/totp/begin', {
      data: { currentPassword: OWNER.password },
    });
    ownerTotpSecret = ((await begun.json()) as { secret: string }).secret;

    await page.request.post('/api/auth/totp/confirm', {
      data: { code: await generateOtp({ secret: ownerTotpSecret }) },
    });

    await page.goto('/');
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
  /**
   * The date the feed put on this balance, for the staleness cases. Null — the
   * default — is a feed that did not say, which is not the same as a fresh one.
   */
  feedBalanceAsOf: Date | null = null,
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
      feedBalanceAsOf,
    },
    select: { id: true },
  });
  return account.id;
}

/**
 * A pending transaction, already categorized.
 *
 * Seeded rather than posted through the API because only a sync creates one: a
 * manual transaction is always entered settled, since the owner typing it in is
 * the same act as the money leaving.
 */
export async function makePendingSpend(
  accountId: string,
  delegationId: string,
  amountCents: bigint,
  description = 'Pending charge',
): Promise<void> {
  const transaction = await prisma.transaction.create({
    data: {
      accountId,
      postedAt: new Date(),
      amountCents,
      descriptionRaw: description,
      description,
      pending: true,
      source: 'simplefin',
      externalId: `e2e-pending-${description}`,
      allocations: { create: { delegationId, amountCents } },
    },
    select: { id: true },
  });

  // The envelope moves the moment it is categorized, which is the whole reason
  // the account balance and the delegation fall out of step.
  await prisma.delegation.update({
    where: { id: delegationId },
    data: { balanceCents: { increment: amountCents } },
  });
  await prisma.delegationEvent.create({
    data: {
      delegationId,
      transactionId: transaction.id,
      eventType: 'categorize',
      deltaCents: amountCents,
    },
  });
}

/** A sync run that succeeded while the feed complained about one institution. */
export async function makeSyncWarning(message: string): Promise<void> {
  await prisma.syncRun.create({
    data: {
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: message,
      correlationId: `e2e-${Date.now()}`,
    },
  });
}

/**
 * Moves the most recent Delegate run back in time.
 *
 * The undo window is measured from the run's `created_at`, so this is how a
 * test reaches "the window has closed" without waiting out the clock.
 */
export async function ageLatestDelegateRun(hours: number): Promise<void> {
  const latest = await prisma.delegateRun.findFirst({
    where: { undoneAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
  if (!latest) throw new Error('No delegate run to age.');

  await prisma.delegateRun.update({
    where: { id: latest.id },
    data: { createdAt: new Date(latest.createdAt.getTime() - hours * 60 * 60 * 1000) },
  });
}
