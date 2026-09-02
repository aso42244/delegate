import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction, splitTransactionEvenly } from '../src/domain/allocations.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The export.
 *
 * Two properties carry the risk. A figure has to be a figure a spreadsheet can
 * add up, and a description has to be text rather than something a spreadsheet
 * runs — a bank description is written by somebody else, and `=HYPERLINK(...)`
 * in a merchant name is a real way to hand a person a document that acts when
 * they open it.
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
  await markTwoFactorEnrolled();
});

async function get(path: string): Promise<{ status: number; body: string; headers: unknown }> {
  const response = await app.inject({ method: 'GET', url: path, headers: { cookie } });
  return { status: response.statusCode, body: response.body, headers: response.headers };
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/export/transactions.csv' });
    expect(response.statusCode).toBe(401);
  });
});

describe('the register', () => {
  it('is a CSV the browser will save, with money as a decimal', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      description: 'Whole Foods Market',
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    const { status, body, headers } = await get('/api/export/transactions.csv');

    expect(status).toBe(200);
    expect((headers as Record<string, string>)['content-type']).toContain('text/csv');
    expect((headers as Record<string, string>)['content-disposition']).toContain('attachment');
    expect(body).toContain('"date","description"');
    // Cents on the wire is a JSON rule (ADR 002). A column of `-4210` in a
    // spreadsheet is a column somebody sums and acts on.
    expect(body).toContain('"-42.10"');
    expect(body).toContain('"Whole Foods Market"');
    expect(body).toContain('"Grocery"');
  });

  it('will not hand a spreadsheet something to run', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    await makeTransaction({
      accountId: account.id,
      amountCents: -1000n,
      description: '=HYPERLINK("http://example.test","CLICK")',
    });

    const { body } = await get('/api/export/transactions.csv');

    // Defused with a leading apostrophe, which a spreadsheet reads as "this is
    // text" and shows in the formula bar rather than the cell.
    expect(body).toContain('"\'=HYPERLINK(');
  });

  it('includes an archived row and says that it is one', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -1000n,
      description: 'Duplicate charge',
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { archivedAt: new Date() },
    });

    const { body } = await get('/api/export/transactions.csv');

    // History rather than noise: an export that dropped them would disagree
    // with the application about what happened.
    const row = body.split('\n').find((line) => line.includes('Duplicate charge'));
    expect(row).toContain('"yes"');
  });
});

describe('the ledger', () => {
  it('carries what a split put in each envelope', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const dining = await makeDelegation({ name: 'Dining' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -6000n,
      description: 'Costco Run',
    });
    await splitTransactionEvenly(prisma, transaction.id, [grocery.id, dining.id]);

    const { body } = await get('/api/export/delegation-events.csv');

    /*
     * The register file has one row for this transaction naming both envelopes;
     * this is the file that says how much went to each. That is why there are
     * two files rather than one wide one — a single file would double-count the
     * amount or lose the split.
     */
    expect(body).toContain('"Grocery","categorize","-30.00"');
    expect(body).toContain('"Dining","categorize","-30.00"');
  });
});

describe('the snapshots', () => {
  it('puts accounts and delegations in one file, keyed by day', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await prisma.accountSnapshot.create({
      data: {
        snapshotDate: new Date('2026-08-31T00:00:00Z'),
        accountId: account.id,
        balanceCents: 500000n,
        provenance: 'observed',
        accountType: 'asset',
        inBudget: true,
        inNetWorth: true,
      },
    });
    await prisma.delegationSnapshot.create({
      data: {
        snapshotDate: new Date('2026-08-31T00:00:00Z'),
        delegationId: grocery.id,
        balanceCents: -4210n,
        provenance: 'observed',
      },
    });

    const { body } = await get('/api/export/snapshots.csv');

    // Both on one date, because a net worth chart drawn in a spreadsheet needs
    // them to line up.
    expect(body).toContain('"2026-08-31","account","Checking","5000.00"');
    expect(body).toContain('"2026-08-31","delegation","Grocery","-42.10"');
  });
});
