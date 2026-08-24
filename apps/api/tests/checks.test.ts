import { computeBudgetIdentity } from '../src/domain/identity.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import {
  clearCheck,
  proposeCheckMatches,
  textNamesCheck,
  writeCheck,
} from '../src/domain/checks.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * Outstanding checks.
 *
 * The assertion repeated throughout is the budget identity. A check moves money
 * between two places without any account changing, and then a bank transaction
 * changes an account without the household deciding anything — if either half is
 * wrong the identity says so immediately, whereas the balances alone would just
 * look plausible.
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
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(setup.headers);
  await markTwoFactorEnrolled();
});

async function balanceOf(id: string): Promise<bigint> {
  const row = await prisma.delegation.findUniqueOrThrow({
    where: { id },
    select: { balanceCents: true },
  });
  return row.balanceCents;
}

async function identityIsZero(): Promise<void> {
  const identity = await computeBudgetIdentity(prisma);
  expect(identity.differenceCents).toBe(0n);
}

/** Checking with $1,000, of which $120 is budgeted for piano lessons. */
async function household(): Promise<{ accountId: string; pianoId: string; foodId: string }> {
  const accountId = await makeAccount({
    name: 'Everyday Checking',
    type: 'asset',
    balanceCents: 100_000n,
  }).then((account) => account.id);

  const pianoId = await makeDelegation({ name: 'Piano Lessons' }).then((line) => line.id);
  const foodId = await makeDelegation({ name: 'Groceries' }).then((line) => line.id);

  // Put the account's money into the two envelopes so the identity starts level.
  await prisma.$transaction(async (tx) => {
    const { adjustDelegationByDelta } = await import('../src/domain/adjust.js');
    await adjustDelegationByDelta(tx, { delegationId: pianoId, deltaCents: 12_000n });
    await adjustDelegationByDelta(tx, { delegationId: foodId, deltaCents: 88_000n });
  });

  await identityIsZero();
  return { accountId, pianoId, foodId };
}

async function write(
  pianoId: string,
  overrides: Partial<{ checkNumber: string; amountCents: bigint }> = {},
): Promise<string> {
  const check = await prisma.$transaction((tx) =>
    writeCheck(tx, {
      checkNumber: overrides.checkNumber ?? '1062',
      amountCents: overrides.amountCents ?? 12_000n,
      issuedAt: new Date('2026-08-01T00:00:00Z'),
      memo: 'Piano lessons',
      sourceDelegationId: pianoId,
    }),
  );
  return check.id;
}

describe('writing a check', () => {
  it('moves the money out of the envelope and leaves the identity level', async () => {
    const { pianoId } = await household();

    const checkId = await write(pianoId);

    expect(await balanceOf(pianoId)).toBe(0n);
    expect(await balanceOf(checkId)).toBe(12_000n);
    // Nothing has left the household yet — the bank does not know.
    await identityIsZero();
  });

  it('files it under a grouping the budget owns', async () => {
    const { pianoId } = await household();
    await write(pianoId);

    const grouping = await prisma.grouping.findFirstOrThrow({
      where: { systemKey: 'outstanding-checks' },
      select: { name: true, section: true },
    });
    expect(grouping).toMatchObject({ name: 'Outstanding Checks', section: 'delegations' });
  });

  it('refuses a second check with the same number while one is outstanding', async () => {
    const { pianoId, foodId } = await household();
    await write(pianoId);

    await expect(write(foodId)).rejects.toThrow(/already outstanding/i);
  });

  it('allows the number again once the first is settled', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);

    const transaction = await makeTransaction({
      accountId,
      amountCents: -12_000n,
      description: 'CHECK 1062',
    });
    await prisma.$transaction((tx) => clearCheck(tx, checkId, transaction.id));

    // A chequebook reuses numbers eventually; only one may be open at a time.
    await expect(write(pianoId)).resolves.toBeTruthy();
  });

  it('refuses an amount of zero or less', async () => {
    const { pianoId } = await household();
    await expect(write(pianoId, { amountCents: 0n })).rejects.toThrow(/positive/i);
  });
});

describe('clearing a check', () => {
  it('attributes the spending to the envelope, not to the check', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);

    const transaction = await makeTransaction({
      accountId,
      amountCents: -12_000n,
      description: 'CHECK 1062',
    });

    await prisma.$transaction((tx) => clearCheck(tx, checkId, transaction.id));
    await prisma.account.update({
      where: { id: accountId },
      data: { balanceCents: 88_000n },
    });

    // The money was spent on piano lessons whether or not it travelled by
    // check. Allocating to the check line would balance and then tell Insights
    // the household spent $120 on "Check 1062".
    const allocations = await prisma.transactionAllocation.findMany({
      where: { transactionId: transaction.id },
      select: { delegationId: true, amountCents: true },
    });
    expect(allocations).toEqual([{ delegationId: pianoId, amountCents: -12_000n }]);

    expect(await balanceOf(pianoId)).toBe(0n);
    expect(await balanceOf(checkId)).toBe(0n);
    await identityIsZero();
  });

  it('archives the check rather than deleting it', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);

    const transaction = await makeTransaction({
      accountId,
      amountCents: -12_000n,
      description: 'CHECK 1062',
    });
    await prisma.$transaction((tx) => clearCheck(tx, checkId, transaction.id));

    const check = await prisma.delegation.findUniqueOrThrow({
      where: { id: checkId },
      select: { archivedAt: true },
    });
    expect(check.archivedAt).not.toBeNull();
  });

  /**
   * The bank is the record of what was actually paid. A check written down as
   * $120 that cleared for $125 leaves the envelope $5 short, which is exactly
   * where someone would want to find the discrepancy.
   */
  it('leaves an overpayment as a shortfall on the envelope', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);

    const transaction = await makeTransaction({
      accountId,
      amountCents: -12_500n,
      description: 'CHECK 1062',
    });

    const result = await prisma.$transaction((tx) => clearCheck(tx, checkId, transaction.id));
    await prisma.account.update({ where: { id: accountId }, data: { balanceCents: 87_500n } });

    expect(result.differenceCents).toBe(-500n);
    expect(await balanceOf(pianoId)).toBe(-500n);
    expect(await balanceOf(checkId)).toBe(0n);
    await identityIsZero();
  });

  it('refuses a deposit, which cannot be a check clearing', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);

    const deposit = await makeTransaction({
      accountId,
      amountCents: 5_000n,
      description: 'Refund',
    });

    await expect(prisma.$transaction((tx) => clearCheck(tx, checkId, deposit.id))).rejects.toThrow(
      /money leaving/i,
    );
  });
});

/**
 * Proposing, not settling. The criteria are the ones the old automatic match
 * used — exact amount and the check number as a whole token — but nothing moves
 * until a person calls `clearCheck`. ADR 030.
 */
describe('proposing a match', () => {
  async function payment(accountId: string, description: string, cents: bigint): Promise<string> {
    const row = await makeTransaction({ accountId, amountCents: cents, description });
    return row.id;
  }

  it('proposes a check when the amount and the number both agree', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);
    const transactionId = await payment(accountId, 'CHECK #1062', -12_000n);

    const proposed = await proposeCheckMatches(prisma);

    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      checkId,
      transactionId,
      checkNumber: '1062',
      checkBalanceCents: 12_000n,
      amountCents: -12_000n,
      description: 'CHECK #1062',
      sourceName: 'Piano Lessons',
    });
  });

  it('settles nothing by itself — the money stays on the check line', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);
    const transactionId = await payment(accountId, 'CHECK #1062', -12_000n);

    await proposeCheckMatches(prisma);

    // The whole point of the change: a sync used to do this unattended.
    expect(await balanceOf(checkId)).toBe(12_000n);
    expect(
      await prisma.delegation.findUniqueOrThrow({
        where: { id: checkId },
        select: { archivedAt: true },
      }),
    ).toEqual({ archivedAt: null });
    expect(await prisma.transactionAllocation.count({ where: { transactionId } })).toBe(0);

    // And it keeps proposing until somebody says yes, because it is recomputed
    // rather than remembered.
    expect(await proposeCheckMatches(prisma)).toHaveLength(1);
  });

  it('is what clearCheck settles, once confirmed', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);
    const transactionId = await payment(accountId, 'CHECK #1062', -12_000n);

    const [proposal] = await proposeCheckMatches(prisma);
    await prisma.$transaction((tx) =>
      clearCheck(tx, proposal!.checkId, proposal!.transactionId, {}),
    );

    expect(await balanceOf(checkId)).toBe(0n);
    expect(await prisma.transactionAllocation.count({ where: { transactionId } })).toBe(1);
    // Nothing left to propose, because the condition stopped being true.
    expect(await proposeCheckMatches(prisma)).toEqual([]);
  });

  it('leaves a payment for the wrong amount alone', async () => {
    const { pianoId, accountId } = await household();
    const checkId = await write(pianoId);
    await payment(accountId, 'CHECK 1062', -9_900n);

    expect(await proposeCheckMatches(prisma)).toEqual([]);
    expect(await balanceOf(checkId)).toBe(12_000n);
  });

  it('leaves a payment that never names the check alone', async () => {
    const { pianoId, accountId } = await household();
    await write(pianoId);
    await payment(accountId, 'CORNER MARKET', -12_000n);

    expect(await proposeCheckMatches(prisma)).toEqual([]);
  });

  it('never proposes a transaction that is already categorized', async () => {
    const { pianoId, foodId, accountId } = await household();
    await write(pianoId);
    const transactionId = await payment(accountId, 'CHECK 1062', -12_000n);

    const { categorizeTransaction } = await import('../src/domain/allocations.js');
    await prisma.$transaction((tx) => categorizeTransaction(tx, transactionId, foodId));

    // Also the way to say "no, that is not the check": categorize it as what it
    // was and the proposal stops being made.
    expect(await proposeCheckMatches(prisma)).toEqual([]);
  });
});

describe('the check number in bank text', () => {
  it('matches a whole token and nothing less', () => {
    expect(textNamesCheck('CHECK 1062', '1062')).toBe(true);
    expect(textNamesCheck('CHECK #1062', '1062')).toBe(true);
    expect(textNamesCheck('Check No. 1062 PIANO', '1062')).toBe(true);
  });

  /**
   * Bank descriptions are full of digits — trace numbers, dates, store numbers.
   * A loose match would settle the wrong check, which moves real money to the
   * wrong envelope.
   */
  it('does not match a number buried inside a longer one', () => {
    expect(textNamesCheck('TRACE 2110629', '1062')).toBe(false);
    expect(textNamesCheck('CHECK 10620', '1062')).toBe(false);
    expect(textNamesCheck('CHECK 21062', '1062')).toBe(false);
  });
});

describe('voiding a check', () => {
  it('gives the money back and archives the line', async () => {
    const { pianoId } = await household();
    const checkId = await write(pianoId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/checks/${checkId}/void`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    expect(await balanceOf(pianoId)).toBe(12_000n);
    expect(await balanceOf(checkId)).toBe(0n);
    await identityIsZero();
  });
});

describe('the rest of the application', () => {
  it('will not archive a delegation with a check drawn on it', async () => {
    const { pianoId } = await household();
    await write(pianoId);

    // It sits at zero once the check is written, so without this guard it looks
    // archivable right up until the check clears and has nowhere to go.
    const response = await app.inject({
      method: 'POST',
      url: `/api/delegations/${pianoId}/archive`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('delegation_has_outstanding_checks');
  });

  it('will not let a check be edited like an envelope', async () => {
    const { pianoId } = await household();
    const checkId = await write(pianoId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/delegations/${checkId}`,
      headers: { cookie },
      payload: { name: 'Something else' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('delegation_is_a_check');
  });

  /**
   * A check has no amount to delegate — null, not zero — so payday leaves it
   * alone. Funding one would put money into a line that is only ever emptied by
   * the bank, and the envelope it came from would be short every cycle.
   */
  it('does not fund a check when Delegate is pressed', async () => {
    const { pianoId } = await household();
    await prisma.delegation.update({
      where: { id: pianoId },
      data: { amountToDelegateCents: 12_000n },
    });

    const before = await app.inject({
      method: 'GET',
      url: '/api/budget/delegate/preview',
      headers: { cookie },
    });
    expect(before.json<{ lineCount: number }>().lineCount).toBe(1);

    await write(pianoId);

    const after = await app.inject({
      method: 'GET',
      url: '/api/budget/delegate/preview',
      headers: { cookie },
    });
    // Still one: the envelope. The check is not a line payday knows about.
    expect(after.json<{ lineCount: number }>().lineCount).toBe(1);
  });

  it('shows outstanding checks last in the budget, under their own grouping', async () => {
    const { pianoId } = await household();
    await write(pianoId);

    const response = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    const body = response.json<{
      delegations: { groupings: { name: string; systemKey: string | null }[] };
    }>();

    const last = body.delegations.groupings.at(-1);
    expect(last?.systemKey).toBe('outstanding-checks');
  });
});
