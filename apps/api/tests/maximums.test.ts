import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { buildBudgetView } from '../src/domain/budget.js';
import { previewDelegate, runDelegate, undoDelegateRun } from '../src/domain/delegate.js';
import { updateDelegation } from '../src/domain/delegations.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { transferBetweenDelegations } from '../src/domain/transfer.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import { makeAccount, makeDelegation, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * A maximum, where it meets the ledger and the page.
 *
 * The arithmetic is proved in `packages/shared`. What matters here is the
 * promise around it, which is the owner's own sentence: a line capped at $400,
 * set to receive $200 a paycheck and already holding $275, takes **$125** on the
 * next press — and the other **$75 stays available to delegate** rather than
 * going anywhere.
 *
 * That second half is the one worth a test of its own. The money is not moved to
 * another line and it is not silently absorbed: the budget's reading rises by
 * exactly what the maximums held back, which is what makes it available for
 * whatever that payday actually needs.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const ZONE = 'America/Chicago';

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

const balanceOf = async (id: string): Promise<bigint> =>
  (await prisma.delegation.findUniqueOrThrow({ where: { id }, select: { balanceCents: true } }))
    .balanceCents;

/**
 * The owner's line: capped at $400, funded at $200, holding $275.
 *
 * The balance is established by an adjustment rather than by setting the column,
 * because the events are the truth and a seeded number would pass while the
 * ledger disagreed.
 */
async function cappedLine(): Promise<{ id: string }> {
  const line = await makeDelegation({
    name: 'Car repairs',
    amountToDelegateCents: 20_000n,
    maxBalanceCents: 40_000n,
  });
  await adjustDelegationByDelta(prisma, {
    delegationId: line.id,
    deltaCents: 27_500n,
    actorId: null,
  });
  return line;
}

describe('a press against a maximum', () => {
  it('puts in only what fits, and leaves the rest to delegate', async () => {
    // $1,000 has landed; $275 of it is already in the capped line.
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const line = await cappedLine();

    const before = await computeBudgetIdentity(prisma);
    expect(before.differenceCents).toBe(72_500n);

    const preview = await previewDelegate(prisma);
    expect(preview.totalCents).toBe(12_500n);
    expect(preview.withheldCents).toBe(7_500n);
    expect(preview.cappedCount).toBe(1);
    // Still a line this press considered, exactly as an explicit $0 line is.
    expect(preview.lineCount).toBe(1);

    await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));

    expect(await balanceOf(line.id)).toBe(40_000n);

    /*
     * The whole point, in one assertion. $725 was undelegated before the press
     * and $600 after it — down by the $125 that went in, not by the $200 the
     * line is set to receive. The $75 is still on the bottom row.
     */
    const after = await computeBudgetIdentity(prisma);
    expect(after.differenceCents).toBe(60_000n);
  });

  it('adds nothing to a line already at its maximum', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const line = await makeDelegation({
      name: 'Car repairs',
      amountToDelegateCents: 20_000n,
      maxBalanceCents: 40_000n,
    });
    await adjustDelegationByDelta(prisma, {
      delegationId: line.id,
      deltaCents: 40_000n,
      actorId: null,
    });

    const preview = await previewDelegate(prisma);
    expect(preview.totalCents).toBe(0n);
    expect(preview.withheldCents).toBe(20_000n);

    await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));
    expect(await balanceOf(line.id)).toBe(40_000n);
  });

  it('funds the line again by itself once it has been spent down', async () => {
    // A maximum needs no undoing: it caps the balance rather than the amount, so
    // the figure the household typed is still there and still works.
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 200_000n });
    const line = await cappedLine();

    await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));
    expect(await balanceOf(line.id)).toBe(40_000n);

    // $300 spent out of it, by hand.
    await adjustDelegationByDelta(prisma, {
      delegationId: line.id,
      deltaCents: -30_000n,
      actorId: null,
    });

    await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));
    // The full $200 this time: $100 held plus $200 is under the ceiling.
    expect(await balanceOf(line.id)).toBe(30_000n);

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: line.id } });
    expect(row.amountToDelegateCents).toBe(20_000n);
  });

  it('is undone exactly, capped amount and all', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const line = await cappedLine();

    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));
    expect(await balanceOf(line.id)).toBe(40_000n);

    await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));
    // Back to the $275 it held, not to $200 short of it: the event that was
    // written is the one that is reversed.
    expect(await balanceOf(line.id)).toBe(27_500n);
  });

  it('leaves an uncapped line alone', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 20_000n });
    await cappedLine();

    const preview = await previewDelegate(prisma);
    expect(preview.totalCents).toBe(32_500n);
    expect(preview.cappedCount).toBe(1);

    await prisma.$transaction((tx) => runDelegate(tx, { actorId: null }));
    expect(await balanceOf(grocery.id)).toBe(20_000n);
  });
});

describe('what a maximum does not cap', () => {
  it('lets a transfer take a line past it', async () => {
    // Only Delegate is capped. A cap that refused a transfer would be enforcing
    // a preference by losing track of money.
    const savings = await makeDelegation({ name: 'Savings', amountToDelegateCents: null });
    const line = await cappedLine();
    await adjustDelegationByDelta(prisma, {
      delegationId: savings.id,
      deltaCents: 50_000n,
      actorId: null,
    });

    await prisma.$transaction((tx) =>
      transferBetweenDelegations(tx, {
        fromDelegationId: savings.id,
        toDelegationId: line.id,
        amountCents: 50_000n,
        actorId: null,
      }),
    );

    expect(await balanceOf(line.id)).toBe(77_500n);
  });

  it('lets a manual adjustment take a line past it', async () => {
    const line = await cappedLine();
    await adjustDelegationByDelta(prisma, {
      delegationId: line.id,
      deltaCents: 50_000n,
      actorId: null,
    });
    expect(await balanceOf(line.id)).toBe(77_500n);
  });
});

describe('setting one', () => {
  it('refuses a maximum of zero, with a sentence rather than a constraint name', async () => {
    const line = await makeDelegation({ name: 'Car repairs', amountToDelegateCents: 20_000n });
    await expect(updateDelegation(prisma, line.id, { maxBalanceCents: 0n })).rejects.toThrow(
      /ceiling/i,
    );
  });

  it('clears with a null, and clears nothing else with it', async () => {
    const line = await cappedLine();
    await updateDelegation(prisma, line.id, { maxBalanceCents: null });

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: line.id } });
    expect(row.maxBalanceCents).toBeNull();
    // The amount to delegate is the household's and is never touched by this.
    expect(row.amountToDelegateCents).toBe(20_000n);
  });

  it('is left alone by a request that does not mention it', async () => {
    const line = await cappedLine();
    await updateDelegation(prisma, line.id, { name: 'Car repair' });

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: line.id } });
    expect(row.maxBalanceCents).toBe(40_000n);
  });
});

describe('on the Budget page', () => {
  it('carries the reading with the row', async () => {
    const line = await cappedLine();

    const view = await buildBudgetView(prisma, { timeZone: ZONE });
    const row = view.delegations.ungrouped.find((entry) => entry.id === line.id);

    expect(row?.max).toEqual({
      maxBalanceCents: 40_000n,
      roomCents: 12_500n,
      delegatingCents: 12_500n,
      withheldCents: 7_500n,
      status: 'partial',
    });
  });

  it('says nothing on a line with no maximum', async () => {
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 20_000n });

    const view = await buildBudgetView(prisma, { timeZone: ZONE });
    expect(view.delegations.ungrouped[0]?.max).toBeNull();
  });

  it('sends it over the wire as decimal strings of cents', async () => {
    await cappedLine();

    const response = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    const body = response.json<{
      delegations: { ungrouped: { name: string; max: { delegatingCents: string } | null }[] };
    }>();
    const row = body.delegations.ungrouped.find((entry) => entry.name === 'Car repairs');

    expect(row?.max?.delegatingCents).toBe('12500');
  });

  it('tells the confirmation what is being held back', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await cappedLine();

    const response = await app.inject({
      method: 'GET',
      url: '/api/budget/delegate/preview',
      headers: { cookie },
    });

    expect(response.json()).toEqual({
      totalCents: '12500',
      lineCount: 1,
      withheldCents: '7500',
      cappedCount: 1,
    });
  });
});
