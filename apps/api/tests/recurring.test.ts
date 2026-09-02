import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { findRecurringBills, overdueBills } from '../src/domain/recurring.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Bills, inferred from the register.
 *
 * The risk here is not a bill that is missed — a page listing four of five bills
 * is still four bills nobody was tracking. It is a merchant that is *not* a bill
 * being called one, because everything downstream of that is confident and
 * wrong: an expected date, and eventually a notification saying something is
 * late when nothing is.
 *
 * So most of these are about declining to answer.
 */

const ZONE = 'America/Chicago';
/** The clock these fixtures are read against, so nothing depends on today. */
const NOW = new Date('2026-09-02T15:00:00Z');

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

async function checking(): Promise<string> {
  const account = await makeAccount({
    name: 'Everyday Checking',
    type: 'asset',
    balanceCents: 500000n,
  });
  return account.id;
}

/** A charge on a given day, with the amount as a positive magnitude. */
async function charge(
  accountId: string,
  isoDay: string,
  magnitudeCents: bigint,
  description: string,
): Promise<{ id: string }> {
  return makeTransaction({
    accountId,
    amountCents: -magnitudeCents,
    description,
    // Mid-morning local, so the household's day and the UTC day agree and the
    // fixtures say what they look like they say.
    postedAt: new Date(`${isoDay}T15:00:00Z`),
  });
}

describe('finding a bill', () => {
  it('reads a monthly charge as monthly, and says when the next is due', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    const [bill, ...rest] = await findRecurringBills(prisma, ZONE, NOW);

    expect(rest).toEqual([]);
    expect(bill?.cadence).toBe('Monthly');
    expect(bill?.occurrences).toBe(3);
    expect(bill?.typicalAmountCents).toBe(11800n);
    // Thirty days on from the last one, which is the interval it has actually
    // been arriving at rather than a calendar month.
    expect(bill?.expectedNextAt.toISOString().slice(0, 10)).toBe('2026-09-03');
  });

  it('tolerates the days a real bill moves by', async () => {
    const accountId = await checking();
    // Month lengths differ by three, a weekend moves a bill by two, and a card
    // posts a day late. All of that is one monthly bill.
    for (const day of ['2026-06-02', '2026-07-06', '2026-08-03']) {
      await charge(accountId, day, 4599n, 'STREAMING SERVICE');
    }

    expect(await findRecurringBills(prisma, ZONE, NOW)).toHaveLength(1);
  });

  it('holds the typical amount apart from the last one', async () => {
    const accountId = await checking();
    await charge(accountId, '2026-06-04', 999n, 'STREAMING SERVICE');
    await charge(accountId, '2026-07-04', 999n, 'STREAMING SERVICE');
    await charge(accountId, '2026-08-04', 1499n, 'STREAMING SERVICE');

    const [bill] = await findRecurringBills(prisma, ZONE, NOW);

    // The whole reason both are carried: a subscription that renewed higher is
    // perfectly ordinary until the two figures sit beside each other.
    expect(bill?.typicalAmountCents).toBe(999n);
    expect(bill?.lastAmountCents).toBe(1499n);
  });

  it('names where the charges are usually filed', async () => {
    const accountId = await checking();
    const home = await makeDelegation({ name: 'Home & Grounds' });
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      const row = await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
      await categorizeTransaction(prisma, row.id, home.id);
    }

    const [bill] = await findRecurringBills(prisma, ZONE, NOW);
    expect(bill?.delegationName).toBe('Home & Grounds');
  });
});

describe('declining to answer', () => {
  it('says nothing about a merchant seen twice', async () => {
    const accountId = await checking();
    await charge(accountId, '2026-07-04', 11800n, 'CITY WATER UTILITY');
    await charge(accountId, '2026-08-04', 11800n, 'CITY WATER UTILITY');

    // Two charges give one interval, and one interval agrees with nothing.
    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
  });

  it('does not call the weekly shop a weekly bill', async () => {
    const accountId = await checking();
    for (const day of ['2026-08-03', '2026-08-11', '2026-08-17', '2026-08-25']) {
      await charge(accountId, day, 8200n, 'KROGER #123 CINCINNATI');
    }

    /*
     * Groceries recur in the plain sense and their gaps are steady enough that a
     * tolerant check would happily fit a schedule through them. A household's
     * actual bills are fortnightly at the fastest, so the honest thing below
     * that is to decline rather than to answer confidently.
     */
    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
  });

  it('refuses a merchant that is sometimes billed and sometimes visited', async () => {
    const accountId = await checking();
    // A monthly subscription with two one-off orders in the middle: the gaps no
    // longer agree, and a schedule fitted through them is one nobody can rely on.
    for (const day of ['2026-05-04', '2026-06-04', '2026-06-19', '2026-07-04']) {
      await charge(accountId, day, 2400n, 'AMAZON MKTPL*RT4G93');
    }

    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
  });

  it('ignores income, a transfer, and a pending charge', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await makeTransaction({
        accountId,
        amountCents: 320000n,
        description: 'ACME PAYROLL',
        postedAt: new Date(`${day}T15:00:00Z`),
        kind: 'income',
      });
      await makeTransaction({
        accountId,
        amountCents: -50000n,
        description: 'CARD PAYMENT',
        postedAt: new Date(`${day}T15:00:00Z`),
        kind: 'transfer',
      });
      await makeTransaction({
        accountId,
        amountCents: -1200n,
        description: 'PENDING THING',
        postedAt: new Date(`${day}T15:00:00Z`),
        pending: true,
      });
    }

    /*
     * Income is not owed. A card payment is not a bill — the bill was the
     * spending on the card, and counting both shows one obligation twice. A
     * pending charge has not settled and its date moves when it does.
     */
    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
  });

  it('leaves an archived charge out of the schedule', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }
    const duplicate = await charge(accountId, '2026-08-05', 11800n, 'CITY WATER UTILITY');
    await prisma.transaction.update({
      where: { id: duplicate.id },
      data: { archivedAt: new Date() },
    });

    // A duplicate taken out of the register must not leave a one-day interval
    // behind it, which would break the agreement between the others.
    expect(await findRecurringBills(prisma, ZONE, NOW)).toHaveLength(1);
  });
});

describe('being late', () => {
  it('is overdue once it is past the grace, and says by how much', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-04', '2026-06-04', '2026-07-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    // Expected 3 August, and it is 2 September.
    const [bill] = await findRecurringBills(prisma, ZONE, NOW);
    expect(bill?.status).toBe('overdue');
    expect(bill?.daysLate).toBe(30);
    expect(overdueBills([bill!])).toHaveLength(1);
  });

  it('does not call a bill late on the day it is due', async () => {
    const accountId = await checking();
    for (const day of ['2026-07-03', '2026-08-02', '2026-09-01']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    // Bills post a day either side routinely. Being told on the day is noise.
    const [bill] = await findRecurringBills(prisma, ZONE, NOW);
    expect(bill?.status).toBe('expected');
    expect(overdueBills([bill!])).toEqual([]);
  });

  it('stops shouting about a bill that has plainly stopped', async () => {
    const accountId = await checking();
    for (const day of ['2026-01-04', '2026-02-04', '2026-03-04']) {
      await charge(accountId, day, 4599n, 'CANCELLED SERVICE');
    }

    /*
     * Six months past due is a service that ended, not a payment that slipped.
     * It stays on the page — that is a fact about the household's spending — and
     * it raises nothing, because a warning nobody can act on teaches people to
     * stop reading warnings.
     */
    const [bill] = await findRecurringBills(prisma, ZONE, NOW);
    expect(bill?.status).toBe('lapsed');
    expect(overdueBills([bill!])).toEqual([]);
  });
});

describe('the route', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/recurring' });
    expect(response.statusCode).toBe(401);
  });

  it('serializes money as strings, never JSON numbers', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/recurring',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const [bill] = response.json<{ bills: { typicalAmountCents: string; cadence: string }[] }>()
      .bills;
    // ADR 002: a JSON number cannot hold large cent values exactly.
    expect(bill?.typicalAmountCents).toBe('11800');
    expect(bill?.cadence).toBe('Monthly');
  });
});
