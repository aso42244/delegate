import { test as base, type APIRequestContext, type Page } from '@playwright/test';
import { generate as generateOtp } from 'otplib';
import { randomUUID } from 'node:crypto';
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

/**
 * Where the whole budget is: Overview, its band showing every line.
 *
 * The Budget page was deleted when ADR 067's trial ended; the band draws the
 * same `DelegationsTable` and `AccountsTable` it did.
 */
export const BUDGET = '/overview?lines=all';

/**
 * The band's other tab: assets and debts, every one of them.
 *
 * "With balance" is the band's default, which hides an account at zero — and a
 * spec usually creates its accounts at zero.
 */
export async function showAccounts(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Accounts & Debts' }).click();
  await page.getByRole('radio', { name: 'All', exact: true }).click();
}

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

  /*
   * Deleted and recreated rather than updated column by column.
   *
   * This row is pinned — the application updates it by id and never creates it
   * — so it survives the truncate above and has to be reset in place. It used
   * to be reset by listing every column, and a column left off that list leaked
   * from one test into the next: the pay cadence did it once, the recurring
   * alerts flag once, and the payday anchor a third time, each found as a
   * confusing failure somewhere unrelated rather than as a missing name here.
   *
   * Recreating from the id alone lets the schema's own defaults apply, so a
   * column added tomorrow is reset without anybody remembering. A column with no
   * default would fail loudly here, at the moment it was added, rather than
   * quietly leaking for a fortnight.
   */
  await prisma.budgetSettings.deleteMany({ where: { id: 1 } });
  await prisma.budgetSettings.create({ data: { id: 1 } });
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

/**
 * An Overview with nothing on it.
 *
 * The page defaults to an arrangement now, so a spec about *arranging* has to
 * start from one it chose — otherwise it is asserting against whatever this
 * release's default happens to be, and every one of them would move the day the
 * default does.
 *
 * Saving an empty layout is a real act, not a no-op: it records that this person
 * has arranged Overview, which is what stops the default standing in again.
 */
export async function emptyOverview(api: APIRequestContext): Promise<void> {
  const response = await api.put('/api/overview/layout', { data: { tiles: [] } });
  if (!response.ok()) {
    throw new Error(`Could not empty the Overview layout: ${response.status()}`);
  }
}

/**
 * Creating a thing, through the one control that does it.
 *
 * There were seven create buttons over five screens and each spec pressed
 * whichever one its own page happened to carry. There is one now, in every page
 * header, so the specs go through it — which also means every one of them is a
 * test that the menu reaches that dialog.
 */
export async function openNew(
  page: import('@playwright/test').Page,
  item: 'Transaction' | 'Transfer' | 'Check' | 'Delegation' | 'Grouping' | 'Rule',
): Promise<void> {
  await page.getByRole('button', { name: 'New …' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
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

    /*
     * Enrolment, checked — and retried once if the clock got in the way.
     *
     * The **previous** period's code is offered because confirming spends what
     * it is given, and the sign-in helper above needs one that has not been
     * used. The race is that "previous" is worked out when the code is
     * generated: if the clock crosses a period boundary between generating and
     * validating, it has become two steps back and the server refuses it.
     *
     * Unchecked, that failure was silent and every later request in the spec
     * answered 403 `two_factor_required` — which surfaces as a fixture blowing
     * up somewhere unrelated, with nothing pointing at enrolment. Retrying
     * recomputes against the new time, and asserting means the third
     * possibility is a named failure rather than twenty confusing ones.
     */
    async function confirmTwoFactor(): Promise<boolean> {
      const response = await page.request.post('/api/auth/totp/confirm', {
        data: {
          code: await generateOtp({
            secret: ownerTotpSecret,
            epoch: Math.floor(Date.now() / 1000) - 30,
          }),
        },
      });
      return response.ok();
    }

    if (!(await confirmTwoFactor()) && !(await confirmTwoFactor())) {
      throw new Error(
        'Two-factor enrolment failed twice in the signed-in fixture. Every request after this would answer 403.',
      );
    }

    /*
     * The fixture's contract is "signed in, looking at the whole budget":
     * Overview, with its band showing every line rather than the chosen few.
     * The band draws the same two tables the Budget page did before ADR 067's
     * trial ended in its deletion, so a spec about a row menu or an editable
     * figure starts where those are. A spec that is about *landing* navigates to
     * `/` itself.
     */
    await page.goto(BUDGET);
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

  /*
   * The status and the body when this goes wrong, not `undefined.id`.
   *
   * A fixture that fails as "Cannot read properties of undefined" reports the
   * line that read the field rather than the request that did not answer, which
   * is a failure in a spec nobody touched pointing at a file nobody suspects.
   * Once, on a loaded machine, that cost a full re-run to learn nothing.
   */
  if (!response.ok()) {
    throw new Error(
      `POST /api/delegations answered ${response.status()}: ${await response.text()}`,
    );
  }
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
  /**
   * Off-budget accounts exist and behave differently. `in_budget` decides which
   * accounts the identity sums, and ADR 050 made that a wall — a property is net
   * worth rather than money the budget can allocate.
   */
  options: {
    readonly inBudget?: boolean;
    /** When the balance was last confirmed. Now, unless a case needs it older. */
    readonly balanceAsOf?: Date;
  } = {},
): Promise<string> {
  const account = await prisma.account.create({
    data: {
      name,
      type,
      source,
      ...(source === 'simplefin' ? { externalId: `e2e-${name}` } : {}),
      balanceCents,
      inBudget: options.inBudget ?? true,
      inNetWorth: true,
      balanceAsOf: options.balanceAsOf ?? new Date(),
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

/**
 * Money in, on a given account, today.
 *
 * `kind: 'income'` is what keeps it out of every spending reading: a payroll
 * deposit is not a day's outflow, and the register's own filters lean on the
 * kind rather than on the sign.
 */
export async function makeIncome(
  accountId: string,
  amountCents: bigint,
  description = 'Payday',
): Promise<void> {
  await prisma.transaction.create({
    data: {
      accountId,
      postedAt: new Date(),
      amountCents,
      descriptionRaw: description,
      description,
      kind: 'income',
      source: 'manual',
    },
    select: { id: true },
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
 * A run that succeeded, and what it brought back.
 *
 * `finishedAt` is what `/api/sync/status` reports as `lastSyncAt`, so a run
 * without it reads as never having completed.
 */
export async function makeSuccessfulSync(transactionsAdded: number): Promise<void> {
  await prisma.syncRun.create({
    data: {
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      transactionsAdded,
      correlationId: `e2e-${Date.now()}`,
    },
  });
}

/** A run that failed outright, which is one of the two conditions that get a bar. */
export async function makeSyncFailure(message: string): Promise<void> {
  await prisma.syncRun.create({
    data: {
      status: 'failed',
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

/**
 * A sync run that succeeded, for the notifications that only speak when the
 * feed itself is working.
 *
 * `feed_not_reporting` is suppressed while the latest run is a failure — a
 * bridge that is down lists nothing, so every account would raise at once and
 * repeat what `sync_failing` already says.
 */
export async function makeSucceededSyncRun(): Promise<void> {
  const now = new Date();
  await prisma.syncRun.create({
    data: { status: 'succeeded', startedAt: now, finishedAt: now, correlationId: 'e2e' },
  });
}

/**
 * A whole invented household: groupings with colours, ten envelopes, four
 * accounts, a pay cycle, and four months of paychecks and categorized spending.
 *
 * For the specs that need a page with something to draw — a cashflow, a tile of
 * percentages, a bill that recurs — and for the README's screenshots, which are
 * of the real application drawing this. Every name and figure here is made up.
 *
 * Written through the ledger rather than around it: every envelope balance is
 * the sum of its events, so the cached-balance check still holds afterwards.
 */
export async function makeHousehold(api: APIRequestContext): Promise<void> {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const daysAgo = (days: number, hour = 15): Date => {
    const date = new Date(now - days * DAY);
    date.setUTCHours(hour, 0, 0, 0);
    return date;
  };

  // Payday every two weeks, the next one five days out.
  const nextPayday = new Date(now + 5 * DAY).toISOString().slice(0, 10);
  const settings = await api.patch('/api/settings', {
    data: { payCadence: 'biweekly', nextPaydayOn: nextPayday },
  });
  if (!settings.ok()) throw new Error(`settings answered ${settings.status()}`);

  const groupings = [
    { name: '1 - Bills', color: '#2783DE' },
    { name: '2 - Food', color: '#46A171' },
    { name: '3 - Home', color: '#D5803B' },
    { name: '4 - Fun', color: '#8B63B8' },
  ];
  const groupingIds = new Map<string, string>();
  for (const [position, grouping] of groupings.entries()) {
    const created = await prisma.grouping.create({
      data: { ...grouping, section: 'delegations', position },
      select: { id: true },
    });
    groupingIds.set(grouping.name, created.id);
  }

  /** Name, grouping, amount to delegate, balance it should end on, utility. */
  const lines: readonly [string, string, bigint, bigint, boolean][] = [
    ['Rent', '1 - Bills', 725_00n, 1_450_00n, false],
    ['Electricity', '1 - Bills', 25_00n, 38_20n, true],
    ['Internet', '1 - Bills', 17_00n, 35_00n, true],
    ['Phone', '1 - Bills', 25_00n, 22_00n, false],
    ['Groceries', '2 - Food', 250_00n, 184_35n, false],
    ['Dining Out', '2 - Food', 60_00n, 21_90n, false],
    ['Home Maintenance', '3 - Home', 50_00n, 412_00n, false],
    ['Car Insurance', '3 - Home', 60_00n, 318_00n, false],
    ['Gifts', '4 - Fun', 25_00n, 96_50n, false],
    ['Vacation', '4 - Fun', 150_00n, 1_275_00n, false],
  ];
  const delegationIds = new Map<string, string>();
  for (const [position, [name, grouping, amount, , isUtility]] of lines.entries()) {
    const created = await prisma.delegation.create({
      data: {
        name,
        groupingId: groupingIds.get(grouping) ?? null,
        amountToDelegateCents: amount,
        isUtility,
        position,
      },
      select: { id: true },
    });
    delegationIds.set(name, created.id);
  }
  await prisma.delegation.update({
    where: { id: delegationIds.get('Vacation')! },
    data: {
      targetCents: 3_000_00n,
      targetDate: new Date(Date.UTC(new Date(now).getUTCFullYear() + 1, 5, 30)),
    },
  });

  const checking = await makeAccount('Everyday Checking', 'asset', 0n, 'simplefin', new Date());
  const card = await makeAccount('Rewards Card', 'debt', 482_17n, 'simplefin', new Date());
  const cash = await makeAccount('Cash', 'asset', 60_00n);
  await makeAccount('High-Yield Savings', 'asset', 8_250_00n, 'simplefin', new Date(), {
    inBudget: false,
  });

  /** A settled, categorized charge, and the envelope movement that goes with it. */
  const spent = new Map<string, bigint>();
  let sequence = 0;
  const charge = async (
    accountId: string,
    line: string,
    cents: bigint,
    description: string,
    days: number,
  ): Promise<void> => {
    const delegationId = delegationIds.get(line)!;
    const amountCents = -cents;
    sequence += 1;
    const transaction = await prisma.transaction.create({
      data: {
        accountId,
        postedAt: daysAgo(days),
        amountCents,
        descriptionRaw: description,
        description,
        source: accountId === cash ? 'manual' : 'simplefin',
        ...(accountId === cash ? {} : { externalId: `household-${sequence}` }),
        allocations: { create: { delegationId, amountCents } },
      },
      select: { id: true },
    });
    await prisma.delegationEvent.create({
      data: {
        delegationId,
        transactionId: transaction.id,
        eventType: 'categorize',
        deltaCents: amountCents,
        occurredAt: daysAgo(days),
      },
    });
    spent.set(line, (spent.get(line) ?? 0n) + cents);
  };

  // Four months of it. Amounts wander a little, the way real ones do.
  const wobble = (base: bigint, i: number): bigint => base + BigInt(((i * 37) % 11) - 5) * 100n;
  for (let i = 0; i < 9; i += 1) {
    await prisma.transaction.create({
      data: {
        accountId: checking,
        postedAt: daysAgo(9 + i * 14, 12),
        amountCents: 2_450_00n,
        descriptionRaw: 'ACH Deposit ACME CORP PAYROLL',
        description: 'ACH Deposit ACME CORP PAYROLL',
        kind: 'income',
        source: 'simplefin',
        externalId: `household-pay-${i}`,
      },
    });
  }
  // A year of utilities, which is what their averages are taken over; four
  // months of everything else.
  for (let month = 0; month < 12; month += 1) {
    const at = 9 + month * 30;
    const season = [74_00n, 68_00n, 55_00n, 41_00n, 38_00n, 52_00n];
    await charge(checking, 'Electricity', season[month % 6]!, 'PRAIRIE POWER & LIGHT', at);
    await charge(checking, 'Internet', 35_00n, 'BLUEPEAK INTERNET', at + 3);
  }
  for (let month = 0; month < 4; month += 1) {
    const at = 3 + month * 30;
    await charge(checking, 'Rent', 1_450_00n, 'OAK RIDGE APARTMENTS RENT', at);
    await charge(card, 'Phone', 45_00n, 'SIGNAL MOBILE', at + 12);
    await charge(card, 'Car Insurance', 60_00n, 'BADGER MUTUAL PREMIUM', at + 15);
  }
  for (let week = 0; week < 17; week += 1) {
    const store = week % 3 === 0 ? 'WHOLEFDS MKT #10234' : 'KROGER #123 SPRINGFIELD';
    await charge(card, 'Groceries', wobble(118_00n, week), store, 2 + week * 7);
    if (week % 2 === 0) {
      await charge(card, 'Dining Out', wobble(34_00n, week), 'THE BLUE SPOON CAFE', 4 + week * 7);
    }
  }
  await charge(cash, 'Gifts', 40_00n, 'MANUAL - Birthday card and gift', 20);
  await charge(card, 'Home Maintenance', 138_00n, 'HARDWARE HAUS #221', 33);

  /*
   * The last payday's Delegate press. A cycle starts at a press rather than at a
   * date, so without one every cycle-shaped tile says no cycle has been run.
   */
  const batchId = randomUUID();
  const run = await prisma.delegateRun.create({
    data: {
      batchId,
      totalCents: lines.reduce((sum, [, , amount]) => sum + amount, 0n),
      lineCount: lines.length,
      createdAt: daysAgo(9, 13),
    },
    select: { id: true },
  });
  for (const [name, , amount] of lines) {
    await prisma.delegationEvent.create({
      data: {
        delegationId: delegationIds.get(name)!,
        eventType: 'delegate',
        deltaCents: amount,
        batchId,
        delegateRunId: run.id,
        occurredAt: daysAgo(9, 13),
      },
    });
  }

  // Every line opens on whatever makes it end where it should: the opening
  // balance is an adjustment, the rest is the press and the spending above.
  let delegated = 0n;
  for (const [name, , amount, balance] of lines) {
    const opening = balance + (spent.get(name) ?? 0n) - amount;
    await prisma.delegationEvent.create({
      data: {
        delegationId: delegationIds.get(name)!,
        eventType: 'adjust',
        deltaCents: opening,
        occurredAt: daysAgo(400),
      },
    });
    await prisma.delegation.update({
      where: { id: delegationIds.get(name)! },
      data: { balanceCents: balance },
    });
    delegated += balance;
  }

  /*
   * Sixty nights of history, for the tiles that draw a line through time. The
   * nightly job writes these; here they are a gentle climb with a wobble, ending
   * near what the accounts above hold today. Invented, like everything else.
   */
  for (let night = 60; night >= 1; night -= 1) {
    const date = new Date(now - night * DAY);
    const drift = BigInt(60 - night) * 26_00n + BigInt(((night * 53) % 17) - 8) * 45_00n;
    const assets = 11_200_00n + drift;
    const debts = 520_00n - BigInt(night % 9) * 12_00n;
    await prisma.aggregateSnapshot.create({
      data: {
        snapshotDate: new Date(
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
        ),
        netWorthAssetsCents: assets,
        netWorthDebtsCents: debts,
        netWorthCents: assets - debts,
        budgetAssetsCents: assets - 8_250_00n,
        budgetDebtsCents: debts,
        totalDelegationsCents: assets - 8_250_00n - debts,
        pendingCategorizedCents: 0n,
        identityValueCents: 0n,
        provenance: 'observed',
      },
    });
  }

  // Checking holds what the envelopes do, less what cash holds, plus what the
  // card owes, plus a paycheck's leftover not yet delegated.
  await prisma.account.update({
    where: { id: checking },
    data: { balanceCents: delegated - 60_00n + 482_17n + 212_40n },
  });
}
