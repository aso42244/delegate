import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import {
  accountBalance,
  delegationBalance,
  ledgerBalances,
  makeAccount,
  makeDelegation,
  makeTransaction,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The Transactions API.
 *
 * The filters are the working queue for a months-long backlog, and the split
 * path is where money can quietly go missing — a set of allocations that does
 * not sum to the transaction would leave an envelope wrong with nothing to show
 * for it.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      // These suites sign in on every test from one address. The limit itself
      // is proved in auth.test.ts, which builds an app with a low one.
      AUTH_RATE_LIMIT_MAX: '100000',
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(response.headers);
});

interface ListBody {
  transactions: {
    id: string;
    amountCents: string;
    description: string;
    allocations: { delegationId: string; amountCents: string }[];
  }[];
  total: number;
}

async function list(query = ''): Promise<ListBody> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/transactions${query}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListBody>();
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(response.statusCode).toBe(401);
  });
});

describe('listing', () => {
  it('serializes cents as strings, never JSON numbers', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    await makeTransaction({ accountId: account.id, amountCents: -4210n, description: 'Grocery' });

    const body = await list();

    // A JSON number cannot hold large cent values exactly. See ADR 002.
    expect(body.transactions[0]?.amountCents).toBe('-4210');
    expect(typeof body.transactions[0]?.amountCents).toBe('string');
  });

  it('hides archived transactions unless asked', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -100n,
      description: 'Gone',
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { archivedAt: new Date() },
    });

    expect((await list()).total).toBe(0);
    expect((await list('?includeArchived=true')).total).toBe(1);
  });

  it('filters to uncategorized, which is the backlog queue', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const categorized = await makeTransaction({
      accountId: account.id,
      amountCents: -100n,
      description: 'Done',
    });
    await makeTransaction({ accountId: account.id, amountCents: -200n, description: 'Todo' });
    await categorizeTransaction(prisma, categorized.id, grocery.id);

    const body = await list('?uncategorized=true');

    expect(body.total).toBe(1);
    expect(body.transactions[0]?.description).toBe('Todo');
  });

  it('finds a split transaction by any of its delegations', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const dining = await makeDelegation({ name: 'Dining' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -10000n,
      description: 'Split shop',
    });

    await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: { cookie },
      payload: {
        allocations: [
          { delegationId: grocery.id, amountCents: '-6000' },
          { delegationId: dining.id, amountCents: '-4000' },
        ],
      },
    });

    expect((await list(`?delegationId=${dining.id}`)).total).toBe(1);
  });

  it('searches description, account name and delegation name', async () => {
    const account = await makeAccount({
      name: 'Frontier Checking',
      type: 'asset',
      balanceCents: 0n,
    });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Whole Foods',
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    expect((await list('?search=whole')).total).toBe(1);
    expect((await list('?search=frontier')).total).toBe(1);
    expect((await list('?search=grocery')).total).toBe(1);
    expect((await list('?search=nothing-here')).total).toBe(0);
  });

  it('searches a typed amount regardless of sign', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    await makeTransaction({ accountId: account.id, amountCents: -4210n, description: 'Spend' });

    // The owner types what is on the screen; the sign is an implementation detail.
    expect((await list('?search=42.10')).total).toBe(1);
    expect((await list('?search=$42.10')).total).toBe(1);
  });

  it('pages without repeating a row when timestamps collide', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    const sameInstant = new Date('2026-08-05T00:00:00Z');
    for (let i = 0; i < 10; i += 1) {
      await makeTransaction({
        accountId: account.id,
        amountCents: BigInt(-100 * (i + 1)),
        description: `Row ${i}`,
        postedAt: sameInstant,
      });
    }

    const first = await list('?limit=5&offset=0');
    const second = await list('?limit=5&offset=5');

    // Backfilled rows routinely share a timestamp; without a tiebreaker in the
    // sort, paging silently repeats and skips rows.
    const ids = new Set([...first.transactions, ...second.transactions].map((t) => t.id));
    expect(ids.size).toBe(10);
  });
});

describe('categorizing', () => {
  it('assigns the whole amount to one delegation', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Grocery',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: { cookie },
      payload: { delegationId: grocery.id },
    });

    expect(response.statusCode).toBe(200);
    expect(await delegationBalance(grocery.id)).toBe(-4210n);
  });

  it('rejects a split that does not sum to the transaction', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const dining = await makeDelegation({ name: 'Dining' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -10000n,
      description: 'Split',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: { cookie },
      payload: {
        allocations: [
          { delegationId: grocery.id, amountCents: '-6000' },
          { delegationId: dining.id, amountCents: '-3000' },
        ],
      },
    });

    // A missing cent here is money that vanished from the budget silently.
    expect(response.statusCode).toBe(400);
    expect(await delegationBalance(grocery.id)).toBe(0n);
  });

  it('splits evenly and still sums exactly', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const a = await makeDelegation({ name: 'A' });
    const b = await makeDelegation({ name: 'B' });
    const c = await makeDelegation({ name: 'C' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -10000n,
      description: 'Thirds',
    });

    await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: { cookie },
      payload: { delegationIds: [a.id, b.id, c.id] },
    });

    // $100.00 across three does not divide; the remainder cent must land
    // somewhere rather than being dropped.
    const total =
      (await delegationBalance(a.id)) +
      (await delegationBalance(b.id)) +
      (await delegationBalance(c.id));
    expect(total).toBe(-10000n);
  });

  it('re-categorizing reverses the previous envelope rather than stacking', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const dining = await makeDelegation({ name: 'Dining' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Moved',
    });

    await categorizeTransaction(prisma, transaction.id, grocery.id);
    await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: { cookie },
      payload: { delegationId: dining.id },
    });

    expect(await delegationBalance(grocery.id)).toBe(0n);
    expect(await delegationBalance(dining.id)).toBe(-4210n);
  });

  it('uncategorizing makes the transaction inert again', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Undone',
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/uncategorize`,
      headers: { cookie },
    });

    expect(await delegationBalance(grocery.id)).toBe(0n);
  });
});

describe('bulk categorizing', () => {
  it('assigns a whole selection at once', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const transaction = await makeTransaction({
        accountId: account.id,
        amountCents: -1000n,
        description: `Row ${i}`,
      });
      ids.push(transaction.id);
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions/bulk-categorize',
      headers: { cookie },
      payload: { transactionIds: ids, delegationId: grocery.id },
    });

    expect(response.json<{ categorized: number }>().categorized).toBe(5);
    expect(await delegationBalance(grocery.id)).toBe(-5000n);
  });

  it('reports a row it could not categorize instead of failing the batch', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const good = await makeTransaction({
      accountId: account.id,
      amountCents: -1000n,
      description: 'Fine',
    });
    // Income allocates to nothing, so it cannot be categorized.
    const income = await makeTransaction({
      accountId: account.id,
      amountCents: 489000n,
      description: 'Paycheck',
      kind: 'income',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions/bulk-categorize',
      headers: { cookie },
      payload: { transactionIds: [good.id, income.id], delegationId: grocery.id },
    });

    const body = response.json<{ categorized: number; failures: { transactionId: string }[] }>();
    // One bad row in a selection of fifty must not be a dead end.
    expect(body.categorized).toBe(1);
    expect(body.failures[0]?.transactionId).toBe(income.id);
  });
});

describe('manual entry', () => {
  it('records a transaction and moves the account balance', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie },
      payload: {
        accountId: account.id,
        amountCents: '-2500',
        description: 'Farmers market, cash',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(await accountBalance(account.id)).toBe(497500n);
  });

  it('refuses an amount too large to be exact as a JSON number', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie },
      payload: {
        accountId: account.id,
        amountCents: Number.MAX_SAFE_INTEGER + 2,
        description: 'Too big',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });

    // Precision was already lost before it reached us; accepting it would
    // persist a different number than the caller sent.
    expect(response.statusCode).toBe(400);
  });

  it('refuses to add to an archived account', async () => {
    const account = await makeAccount({ name: 'Old', type: 'asset', balanceCents: 0n });
    await prisma.account.update({ where: { id: account.id }, data: { archivedAt: new Date() } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie },
      payload: {
        accountId: account.id,
        amountCents: '-100',
        description: 'Nope',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('archiving', () => {
  it('reverses what the transaction moved and backs the balance out', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie },
      payload: {
        accountId: account.id,
        amountCents: '-2500',
        description: 'Entered by mistake',
        postedAt: '2026-08-05T00:00:00Z',
      },
    });
    const id = created.json<{ transaction: { id: string } }>().transaction.id;
    await categorizeTransaction(prisma, id, grocery.id);

    await app.inject({
      method: 'POST',
      url: `/api/transactions/${id}/archive`,
      headers: { cookie },
    });

    // Envelope and account both return to exactly where they were.
    expect(await delegationBalance(grocery.id)).toBe(0n);
    expect(await accountBalance(account.id)).toBe(500000n);

    // Archived, never deleted.
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).not.toBeNull();
  });

  it('leaves cached balances agreeing with the ledger', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Grocery',
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/archive`,
      headers: { cookie },
    });

    const fromEvents = await ledgerBalances();
    expect(await delegationBalance(grocery.id)).toBe(fromEvents.get(grocery.id) ?? 0n);
  });
});

describe('editing', () => {
  it('refuses to relabel a categorized transaction as income', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Grocery',
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${transaction.id}`,
      headers: { cookie },
      payload: { kind: 'income' },
    });

    // Income allocates to nothing, so this would leave allocations that must
    // not exist.
    expect(response.statusCode).toBe(409);
  });
});
