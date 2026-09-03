import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import {
  findRecurringBills,
  linkChargeToBill,
  linkedCharges,
  listHiddenBills,
  overdueBills,
  setBillOverride,
  unlinkChargeFromBill,
} from '../src/domain/recurring.js';
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

describe('saying it is not a bill', () => {
  /** The case from the first real run: a thrift shop visited every fortnight. */
  async function thriftShop(accountId: string): Promise<void> {
    for (const day of ['2026-07-21', '2026-08-04', '2026-08-18']) {
      await charge(accountId, day, 7150n, 'SAVERS - 1090 SIOUX FALLS SD');
    }
  }

  it('takes it off the list, and it stays off', async () => {
    const accountId = await checking();
    await thriftShop(accountId);

    const [detected] = await findRecurringBills(prisma, ZONE, NOW);
    expect(detected?.name).toBe('SAVERS - 1090 SIOUX FALLS SD');

    await setBillOverride(prisma, { key: detected!.key, label: detected!.name, hidden: true });

    // No threshold would have known this was a shop. Only the household does.
    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
  });

  it('raises nothing once hidden', async () => {
    const accountId = await checking();
    // Three monthly charges that stopped, so it would otherwise be overdue.
    for (const day of ['2026-05-05', '2026-06-04', '2026-07-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    const [detected] = await findRecurringBills(prisma, ZONE, NOW);
    expect(overdueBills([detected!])).toHaveLength(1);

    await setBillOverride(prisma, { key: detected!.key, label: detected!.name, hidden: true });

    expect(overdueBills(await findRecurringBills(prisma, ZONE, NOW))).toEqual([]);
  });

  it('is listed so it can be put back, under the name it had', async () => {
    const accountId = await checking();
    await thriftShop(accountId);
    const [detected] = await findRecurringBills(prisma, ZONE, NOW);
    await setBillOverride(prisma, { key: detected!.key, label: detected!.name, hidden: true });

    // A hidden merchant has no detected bill to take a name from — that is what
    // hiding it means — so the label recorded at the time is all there is.
    expect(await listHiddenBills(prisma)).toEqual([
      { key: detected!.key, label: 'SAVERS - 1090 SIOUX FALLS SD' },
    ]);

    await setBillOverride(prisma, { key: detected!.key, label: detected!.name, hidden: false });
    expect(await findRecurringBills(prisma, ZONE, NOW)).toHaveLength(1);
    expect(await listHiddenBills(prisma)).toEqual([]);
  });
});

describe('giving it a name', () => {
  it('shows the household name and keeps the bank text beside it', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 10595n, 'ACH Payment SIOUXFALLS SD UTILITY 605-367-8869');
    }

    const [detected] = await findRecurringBills(prisma, ZONE, NOW);
    await setBillOverride(prisma, {
      key: detected!.key,
      label: detected!.name,
      displayName: 'Water & Sewer',
    });

    const [renamed] = await findRecurringBills(prisma, ZONE, NOW);
    expect(renamed?.name).toBe('Water & Sewer');
    expect(renamed?.renamed).toBe(true);
    // The original is never replaced: reconciling against a statement needs it.
    expect(renamed?.feedName).toBe('ACH Payment SIOUXFALLS SD UTILITY 605-367-8869');
  });

  it('goes back to the bank description when the name is cleared', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 10595n, 'SIOUXFALLS SD UTILITY');
    }
    const [detected] = await findRecurringBills(prisma, ZONE, NOW);

    await setBillOverride(prisma, {
      key: detected!.key,
      label: detected!.name,
      displayName: 'Water & Sewer',
    });
    await setBillOverride(prisma, {
      key: detected!.key,
      label: detected!.name,
      displayName: null,
    });

    const [plain] = await findRecurringBills(prisma, ZONE, NOW);
    expect(plain?.name).toBe('SIOUXFALLS SD UTILITY');
    expect(plain?.renamed).toBe(false);
    // A row that hides nothing and renames nothing says nothing, so nothing is
    // kept: the bill is derived from transactions that are all still there.
    expect(await prisma.billOverride.count()).toBe(0);
  });

  it('keeps a name and a hiding apart', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 10595n, 'SIOUXFALLS SD UTILITY');
    }
    const [detected] = await findRecurringBills(prisma, ZONE, NOW);

    await setBillOverride(prisma, {
      key: detected!.key,
      label: detected!.name,
      displayName: 'Water & Sewer',
      hidden: true,
    });

    expect(await findRecurringBills(prisma, ZONE, NOW)).toEqual([]);
    expect(await listHiddenBills(prisma)).toHaveLength(1);
  });
});

describe('the order', () => {
  it('puts a bill that has plainly stopped at the bottom', async () => {
    const accountId = await checking();
    // Stopped in March, so its expected date is months in the past.
    for (const day of ['2026-01-04', '2026-02-04', '2026-03-04']) {
      await charge(accountId, day, 4599n, 'CANCELLED SERVICE');
    }
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 11800n, 'CITY WATER UTILITY');
    }

    /*
     * A plain date sort puts the least actionable row first, which is exactly
     * where the first real run put a thrift shop last seen in July.
     */
    const bills = await findRecurringBills(prisma, ZONE, NOW);
    expect(bills.map((bill) => bill.status)).toEqual(['due', 'lapsed']);
  });
});

describe('the route', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/recurring' });
    expect(response.statusCode).toBe(401);
  });

  it('records a correction, and leaves the rest of it alone', async () => {
    const accountId = await checking();
    for (const day of ['2026-06-04', '2026-07-04', '2026-08-04']) {
      await charge(accountId, day, 10595n, 'SIOUXFALLS SD UTILITY');
    }
    const [detected] = await findRecurringBills(prisma, ZONE, NOW);

    const named = await app.inject({
      method: 'POST',
      url: '/api/recurring/overrides',
      headers: { cookie },
      payload: { key: detected!.key, label: detected!.name, displayName: 'Water & Sewer' },
    });
    expect(named.statusCode).toBe(200);

    // Hiding it afterwards must not throw the name away, and the request that
    // hides it says nothing about a name.
    await app.inject({
      method: 'POST',
      url: '/api/recurring/overrides',
      headers: { cookie },
      payload: { key: detected!.key, label: detected!.name, hidden: true },
    });

    const stored = await prisma.billOverride.findUniqueOrThrow({
      where: { merchantKey: detected!.key },
    });
    expect(stored.hidden).toBe(true);
    expect(stored.displayName).toBe('Water & Sewer');
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

/**
 * A bill that has been paid and does not know it.
 *
 * Both of these come from the first run against real data. A life insurance
 * payment left the account and sat in the register while its bill read
 * **Overdue · 5d**, because the charge was still pending — and pending charges
 * are excluded from the detection on purpose, since their date moves when they
 * settle. Excluding them from the arithmetic is right; excluding them from the
 * question "has this arrived?" was not.
 */
describe('a charge that has arrived but not settled', () => {
  it('stops a bill reading overdue, and says what it is instead', async () => {
    const accountId = await checking();
    // Monthly on the 28th, last seen in July: expected 27 August, and by
    // 2 September it is six days late.
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'ACH Payment +Lincoln Nationa EDI PYMNTS');
    }

    const [before] = await findRecurringBills(prisma, ZONE, NOW);
    expect(before?.status).toBe('overdue');

    await makeTransaction({
      accountId,
      amountCents: -3096n,
      description: 'ACH Payment +Lincoln Nationa EDI PYMNTS',
      postedAt: new Date('2026-09-01T15:00:00Z'),
      pending: true,
    });

    const [after] = await findRecurringBills(prisma, ZONE, NOW);
    expect(after?.status).toBe('arrived');
    expect(after?.daysLate).toBe(0);
    expect(after?.pendingSince?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  /**
   * The reason pending charges were excluded in the first place, still true.
   *
   * A pending date moves when it settles, so letting one into the arithmetic
   * would shift the prediction by however long the feed took.
   */
  it('does not move the schedule or the next expected date', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'ACH Payment +Lincoln Nationa EDI PYMNTS');
    }
    const [before] = await findRecurringBills(prisma, ZONE, NOW);

    await makeTransaction({
      accountId,
      amountCents: -3096n,
      description: 'ACH Payment +Lincoln Nationa EDI PYMNTS',
      postedAt: new Date('2026-09-01T15:00:00Z'),
      pending: true,
    });

    const [after] = await findRecurringBills(prisma, ZONE, NOW);
    expect(after?.cadence).toBe(before?.cadence);
    expect(after?.intervalDays).toBe(before?.intervalDays);
    expect(after?.expectedNextAt.getTime()).toBe(before?.expectedNextAt.getTime());
  });

  it('is not announced, because nothing needs doing about it', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'ACH Payment +Lincoln Nationa EDI PYMNTS');
    }
    await makeTransaction({
      accountId,
      amountCents: -3096n,
      description: 'ACH Payment +Lincoln Nationa EDI PYMNTS',
      postedAt: new Date('2026-09-01T15:00:00Z'),
      pending: true,
    });

    expect(overdueBills(await findRecurringBills(prisma, ZONE, NOW))).toEqual([]);
  });

  /**
   * A pending row older than the last settled charge is the tail of a period
   * already accounted for — usually one caught mid-settlement. Counting it would
   * mark every bill as arrived for ever.
   */
  it('ignores a pending charge older than the last settled one', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'ACH Payment +Lincoln Nationa EDI PYMNTS');
    }
    await makeTransaction({
      accountId,
      amountCents: -3096n,
      description: 'ACH Payment +Lincoln Nationa EDI PYMNTS',
      postedAt: new Date('2026-07-27T15:00:00Z'),
      pending: true,
    });

    const [bill] = await findRecurringBills(prisma, ZONE, NOW);
    expect(bill?.status).toBe('overdue');
  });
});

/**
 * Saying so by hand, for what no threshold reaches.
 *
 * A merchant that renames itself between charges gets a new key, so its old bill
 * goes overdue for ever while the new one has too little history to be detected
 * at all. Only the household knows they are the same bill.
 */
describe('attaching a charge to a bill', () => {
  it('moves the last-seen date and clears the overdue', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'LINCOLN LIFE PREMIUM');
    }
    // The same bill, under the name the insurer changed to.
    const renamed = await charge(accountId, '2026-08-31', 3096n, 'PROTECTIVE LIFE PREMIUM');

    const [before] = await findRecurringBills(prisma, ZONE, NOW);
    expect(before?.status).toBe('overdue');

    await linkChargeToBill(prisma, {
      key: before!.key,
      transactionId: renamed.id,
      userId: null,
    });

    const [after] = await findRecurringBills(prisma, ZONE, NOW);
    expect(after?.status).not.toBe('overdue');
    expect(after?.lastPostedAt.toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(after?.linkedCount).toBe(1);
  });

  /**
   * The reason a link is kept out of the interval arithmetic.
   *
   * A charge three days after the last one puts a three-day gap in a monthly
   * history. Fitted, that gap fails the tolerance test and the bill disappears
   * from the page — a spectacularly unhelpful answer to "this did arrive".
   */
  it('never changes the cadence, and never drops the bill off the page', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'LINCOLN LIFE PREMIUM');
    }
    const nearby = await charge(accountId, '2026-08-31', 3096n, 'PROTECTIVE LIFE PREMIUM');

    const [before] = await findRecurringBills(prisma, ZONE, NOW);
    await linkChargeToBill(prisma, { key: before!.key, transactionId: nearby.id, userId: null });

    const after = await findRecurringBills(prisma, ZONE, NOW);
    expect(after).toHaveLength(1);
    expect(after[0]?.cadence).toBe('Monthly');
    expect(after[0]?.intervalDays).toBe(before?.intervalDays);
  });

  it('keeps the bill named after the merchant, not the charge attached to it', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'LINCOLN LIFE PREMIUM');
    }
    const renamed = await charge(accountId, '2026-08-31', 3096n, 'PROTECTIVE LIFE PREMIUM');

    const [before] = await findRecurringBills(prisma, ZONE, NOW);
    await linkChargeToBill(prisma, { key: before!.key, transactionId: renamed.id, userId: null });

    const [after] = await findRecurringBills(prisma, ZONE, NOW);
    expect(after?.feedName).toBe('LINCOLN LIFE PREMIUM');
  });

  it('is undone, and the bill goes back to what the register said', async () => {
    const accountId = await checking();
    for (const day of ['2026-05-28', '2026-06-28', '2026-07-28']) {
      await charge(accountId, day, 3096n, 'LINCOLN LIFE PREMIUM');
    }
    const renamed = await charge(accountId, '2026-08-31', 3096n, 'PROTECTIVE LIFE PREMIUM');
    const [before] = await findRecurringBills(prisma, ZONE, NOW);

    await linkChargeToBill(prisma, { key: before!.key, transactionId: renamed.id, userId: null });
    await unlinkChargeFromBill(prisma, renamed.id);

    const [after] = await findRecurringBills(prisma, ZONE, NOW);
    expect(after?.status).toBe('overdue');
    expect(after?.linkedCount).toBe(0);
  });

  it('refuses income and transfers, whatever they are filed as', async () => {
    const accountId = await checking();
    const income = await makeTransaction({
      accountId,
      amountCents: 320000n,
      description: 'ACME PAYROLL',
      postedAt: new Date('2026-09-01T15:00:00Z'),
      kind: 'income',
    });

    await expect(
      linkChargeToBill(prisma, {
        key: 'lincoln life premium',
        transactionId: income.id,
        userId: null,
      }),
    ).rejects.toThrow(/ordinary spending/);
  });

  it('belongs to one bill at a time, so attaching it again moves it', async () => {
    const accountId = await checking();
    const only = await charge(accountId, '2026-09-01', 3096n, 'SOMETHING');

    await linkChargeToBill(prisma, { key: 'bill one', transactionId: only.id, userId: null });
    await linkChargeToBill(prisma, { key: 'bill two', transactionId: only.id, userId: null });

    expect(await linkedCharges(prisma, 'bill one')).toEqual([]);
    expect(await linkedCharges(prisma, 'bill two')).toHaveLength(1);
  });
});
